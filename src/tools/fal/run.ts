import { writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { createConfiguredFalClient } from "../../fal/client.js";
import { fetchQueueResultOutcome, materializeRunFailure } from "../../fal/final-result.js";
import { waitForQueueCompletion } from "../../fal/queue.js";
import { materializeRunResult } from "../../fal/run-result.js";
import { prepareInputUploads } from "../../fal/uploads.js";
import { createRunId, ensureWorkspace, saveRunRecord } from "../../fal/workspaces.js";
import { getFalApiKey } from "../../runtime.js";
import { writeJsonFile } from "../../runtime/files.js";
import type { RunRecord } from "../../runtime.js";
import { okResponse, type FalToolContext } from "../shared.js";

const runSchema = z.object({
  endpointId: z.string().describe("fal endpoint id to call, for example fal-ai/nano-banana-2."),
  input: z.record(z.unknown()).default({}).describe("Raw model input payload."),
  uploadFiles: z.array(z.object({
    inputPath: z.string(),
    localPath: z.string()
  })).optional().describe("Optional local-file uploads mapped into the input with JSON pointers."),
  mode: z.enum(["queue", "sync"]).optional().describe("Use queue by default. Sync is only for short direct calls."),
  wait: z.enum(["submit", "complete"]).optional().describe("submit returns request ids right away; complete waits for a bounded time."),
  waitMs: z.number().int().positive().optional().describe("Optional wait timeout when wait=complete."),
  workspaceId: z.string().optional().describe("Existing workspace id to save run files into."),
  workspaceLabel: z.string().optional().describe("Optional label when a new workspace is created."),
  priority: z.enum(["low", "normal"]).optional().describe("Optional queue priority when supported."),
  hint: z.string().optional().describe("Optional execution hint passed through to fal.")
});

const SAFE_COMPLETE_WAIT_MS = 95_000;

function getHistoryVisibilityNote(input: Record<string, unknown>): string | null {
  return input.sync_mode === true
    ? "sync_mode=true keeps output data out of fal request history previews."
    : null;
}

export function registerFalRunTool(context: FalToolContext): void {
  context.server.registerTool(
    "fal_run",
    {
      title: "run a fal model",
      description: "Submit one fal model run. Default wait=submit returns request ids immediately, then use fal_request to wait, inspect status, or fetch the final result.",
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
        wait: input.wait ?? "submit",
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

      const historyNote = getHistoryVisibilityNote(preparedInput);
      const waitMode = input.wait ?? "submit";
      if (waitMode === "submit") {
        return okResponse({
          ok: true,
          mode: "queue",
          status: enqueued.status,
          workspaceId: record.workspaceId,
          runId: record.runId,
          requestId: enqueued.request_id,
          uploads: record.uploads ?? [],
          queue: enqueued,
          historyNote
        });
      }

      const requestedWaitMs = input.waitMs ?? runtime.defaults.waitMs;
      const effectiveWaitMs = Math.min(requestedWaitMs, SAFE_COMPLETE_WAIT_MS);
      const waitResult = await waitForQueueCompletion({
        falClient,
        endpointId: input.endpointId,
        requestId: enqueued.request_id,
        pollIntervalMs: runtime.defaults.pollIntervalMs,
        timeoutMs: effectiveWaitMs,
        logs: true,
        onStatus: async status => {
          await writeJsonFile(statusPath, status);
          record = {
            ...record,
            updatedAt: new Date().toISOString(),
            status: status.status
          };
          nextState = await saveRunRecord(runtime, nextState, record);
          await context.savePersistedState(nextState, "fal_run_status");
        }
      });

      if (waitResult.completed) {
        const finalOutcome = await fetchQueueResultOutcome({
          apiKey,
          falClient,
          endpointId: input.endpointId,
          requestId: enqueued.request_id,
          latestStatus: waitResult.latestStatus
        });
        if (finalOutcome.kind === "success") {
          const finalized = await materializeRunResult(runtime, nextState, record, finalOutcome.result);
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
            result: finalized.publicResult,
            historyNote
          });
        }

        const failed = await materializeRunFailure(runtime, nextState, record, finalOutcome.failure, finalOutcome.responseBody);
        nextState = failed.nextState;
        await context.savePersistedState(nextState, "fal_run_provider_failure");
        return okResponse({
          ok: true,
          mode: "queue",
          status: "FAILED",
          queueStatus: waitResult.latestStatus.status,
          workspaceId: record.workspaceId,
          runId: record.runId,
          requestId: enqueued.request_id,
          uploads: record.uploads ?? [],
          rawResultPath: failed.rawResultPath,
          error: finalOutcome.failure,
          historyNote,
          latestStatus: waitResult.latestStatus
        });
      }

      if (waitResult.terminalFailure) {
        return okResponse({
          ok: true,
          mode: "queue",
          status: waitResult.latestStatus.status,
          workspaceId: record.workspaceId,
          runId: record.runId,
          requestId: enqueued.request_id,
          uploads: record.uploads ?? [],
          latestStatus: waitResult.latestStatus,
          historyNote
        });
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
        latestStatus: waitResult.latestStatus,
        historyNote,
        hint: `Run is still in progress. Call fal_request with action=wait or action=result and runId=${record.runId}.`
      });
    }
  );
}
