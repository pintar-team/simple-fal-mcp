import { writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { createConfiguredFalClient } from "../../fal/client.js";
import { materializeRunResult } from "../../fal/run-result.js";
import { prepareInputUploads } from "../../fal/uploads.js";
import { createRunId, ensureWorkspace, saveRunRecord } from "../../fal/workspaces.js";
import { getFalApiKey } from "../../runtime.js";
import { writeJsonFile } from "../../runtime/files.js";
import type { RunRecord } from "../../runtime.js";
import { okResponse, type FalToolContext } from "../shared.js";

const runSchema = z.object({
  endpointId: z.string(),
  input: z.record(z.unknown()).default({}),
  uploadFiles: z.array(z.object({
    inputPath: z.string(),
    localPath: z.string()
  })).optional(),
  mode: z.enum(["queue", "sync"]).optional(),
  wait: z.enum(["submit", "complete"]).optional(),
  waitMs: z.number().int().positive().optional(),
  workspaceId: z.string().optional(),
  workspaceLabel: z.string().optional(),
  priority: z.enum(["low", "normal"]).optional(),
  hint: z.string().optional()
});

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

const SAFE_COMPLETE_WAIT_MS = 95_000;

export function registerFalRunTool(context: FalToolContext): void {
  context.server.registerTool(
    "fal_run",
    {
      title: "run a fal model",
      description: "Execute one fal endpoint. Use uploadFiles with JSON pointer fields from fal_model. wait=submit returns immediately; wait=complete waits briefly, then returns a recoverable in-progress handle if needed.",
      inputSchema: runSchema
    },
    async input => {
      await context.reloadRuntime("fal_run");
      const runtime = context.getRuntime();
      const apiKey = getFalApiKey(context.getAuth());
      if (!apiKey) {
        throw new Error("fal_run requires FAL_KEY. Configure it first.");
      }

      const workspace = await ensureWorkspace(
        runtime,
        context.getPersistedState(),
        input.workspaceId,
        input.workspaceLabel
      );
      let nextState = workspace.state;
      const runId = createRunId();
      const createdAt = new Date().toISOString();
      const runDirectory = path.join(workspace.entry.path, "runs", runId);
      const inputPath = path.join(runDirectory, "request.json");
      const statusPath = path.join(runDirectory, "status.json");
      const responsePath = path.join(runDirectory, "response.json");
      const artifactsDir = path.join(runDirectory, "artifacts");

      let record: RunRecord = {
        runId,
        workspaceId: workspace.entry.workspaceId,
        endpointId: input.endpointId,
        mode: input.mode ?? "queue",
        createdAt,
        updatedAt: createdAt,
        status: input.mode === "sync" ? "RUNNING" : "IN_QUEUE",
        inputPath,
        statusPath,
        responsePath,
        artifactsDir,
        artifacts: [],
        uploads: []
      };
      nextState = await saveRunRecord(runtime, nextState, record);
      await context.savePersistedState(nextState, "fal_run_create");

      let preparedInput = structuredClone(input.input);
      let inputForStorage: Record<string, unknown> = structuredClone(input.input);
      try {
        const prepared = await prepareInputUploads(apiKey, runtime, preparedInput, input.uploadFiles ?? []);
        preparedInput = prepared.preparedInput;
        inputForStorage = prepared.sanitizedInput;
        record = {
          ...record,
          updatedAt: new Date().toISOString(),
          uploads: prepared.uploads
        };
      } catch (error) {
        const uploads = typeof error === "object" && error !== null && "uploads" in error
          ? (error as { uploads: NonNullable<RunRecord["uploads"]> }).uploads
          : [];
        record = {
          ...record,
          updatedAt: new Date().toISOString(),
          status: "FAILED",
          uploads,
          error: error instanceof Error ? error.message : String(error)
        };
        nextState = await saveRunRecord(runtime, nextState, record);
        await context.savePersistedState(nextState, "fal_run_upload_failed");
        throw error instanceof Error ? error : new Error(String(error));
      }

      await writeJsonFile(inputPath, {
        endpointId: input.endpointId,
        mode: input.mode ?? "queue",
        wait: input.wait ?? "complete",
        input: inputForStorage,
        uploadFiles: record.uploads ?? []
      });
      nextState = await saveRunRecord(runtime, nextState, record);
      await context.savePersistedState(nextState, "fal_run_input_ready");

      const falClient = createConfiguredFalClient(apiKey);

      if (input.mode === "sync") {
        const result = await falClient.run(input.endpointId, { input: preparedInput });
        const finalized = await materializeRunResult(
          runtime,
          nextState,
          {
            ...record,
            requestId: result.requestId
          },
          result
        );
        nextState = finalized.nextState;
        await context.savePersistedState(nextState, "fal_run_sync_complete");
        return okResponse({
          ok: true,
          mode: "sync",
          status: "COMPLETED",
          workspaceId: finalized.updatedRun.workspaceId,
          runId: finalized.updatedRun.runId,
          requestId: finalized.updatedRun.requestId ?? null,
          uploads: finalized.updatedRun.uploads ?? [],
          artifacts: finalized.artifacts,
          artifactIssues: finalized.artifactIssues,
          rawResultPath: finalized.rawResultPath,
          result: finalized.publicResult
        });
      }

      const enqueued = await falClient.queue.submit(input.endpointId, {
        input: preparedInput,
        priority: input.priority,
        hint: input.hint
      });
      await writeJsonFile(statusPath, enqueued);
      record = {
        ...record,
        requestId: enqueued.request_id,
        updatedAt: new Date().toISOString(),
        status: enqueued.status
      };
      nextState = await saveRunRecord(runtime, nextState, record);
      await context.savePersistedState(nextState, "fal_run_enqueued");

      const waitMode = input.wait ?? "complete";
      if (waitMode === "submit") {
        return okResponse({
          ok: true,
          mode: "queue",
          status: enqueued.status,
          workspaceId: record.workspaceId,
          runId: record.runId,
          requestId: enqueued.request_id,
          uploads: record.uploads ?? [],
          queue: enqueued
        });
      }

      const requestedWaitMs = input.waitMs ?? runtime.defaults.waitMs;
      const effectiveWaitMs = Math.min(requestedWaitMs, SAFE_COMPLETE_WAIT_MS);
      const deadline = Date.now() + effectiveWaitMs;
      let latestStatus: unknown = enqueued;

      while (Date.now() < deadline) {
        const status = await falClient.queue.status(input.endpointId, {
          requestId: enqueued.request_id,
          logs: true
        });
        latestStatus = status;
        await writeJsonFile(statusPath, status);
        record = {
          ...record,
          updatedAt: new Date().toISOString(),
          status: status.status
        };
        nextState = await saveRunRecord(runtime, nextState, record);
        await context.savePersistedState(nextState, "fal_run_status");
        if (status.status === "COMPLETED") {
          const result = await falClient.queue.result(input.endpointId, {
            requestId: enqueued.request_id
          });
          const finalized = await materializeRunResult(runtime, nextState, record, result);
          nextState = finalized.nextState;
          await context.savePersistedState(nextState, "fal_run_complete");
          return okResponse({
            ok: true,
            mode: "queue",
            status: "COMPLETED",
            workspaceId: record.workspaceId,
            runId: record.runId,
            requestId: enqueued.request_id,
            uploads: record.uploads ?? [],
            artifacts: finalized.artifacts,
            artifactIssues: finalized.artifactIssues,
            rawResultPath: finalized.rawResultPath,
            result: finalized.publicResult
          });
        }
        await sleep(runtime.defaults.pollIntervalMs);
      }

      await writeFile(path.join(runDirectory, "timeout.txt"), `Timed out after ${effectiveWaitMs}ms\n`);
      return okResponse({
        ok: true,
        mode: "queue",
        status: "IN_PROGRESS",
        workspaceId: record.workspaceId,
        runId: record.runId,
        requestId: enqueued.request_id,
        waitRequestedMs: requestedWaitMs,
        waitCappedMs: effectiveWaitMs,
        uploads: record.uploads ?? [],
        latestStatus,
        hint: `Run is still in progress. Call fal_request with action=result and runId=${record.runId}.`
      });
    }
  );
}
