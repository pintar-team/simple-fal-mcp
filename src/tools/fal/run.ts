import { writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { createConfiguredFalClient, uploadLocalFile } from "../../fal/client.js";
import { materializeArtifactsToWorkspace, setJsonPointer } from "../../fal/result.js";
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

export function registerFalRunTool(context: FalToolContext): void {
  context.server.registerTool(
    "fal_run",
    {
      title: "run a fal model",
      description: "Execute a fal model endpoint with raw input, optional local-file uploads, and a temporary local workspace for saved request payloads and output artifacts.",
      inputSchema: runSchema
    },
    async input => {
      await context.reloadRuntime("fal_run");
      const runtime = context.getRuntime();
      const apiKey = getFalApiKey(context.getAuth());
      if (!apiKey) {
        throw new Error("fal_run requires FAL_KEY. Configure it first.");
      }

      const preparedInput = structuredClone(input.input);
      for (const upload of input.uploadFiles ?? []) {
        const uploadedUrl = await uploadLocalFile(apiKey, runtime, upload.localPath);
        setJsonPointer(preparedInput, upload.inputPath, uploadedUrl);
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

      await writeJsonFile(inputPath, {
        endpointId: input.endpointId,
        mode: input.mode ?? "queue",
        wait: input.wait ?? "complete",
        input: preparedInput,
        uploadFiles: input.uploadFiles ?? []
      });

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
        artifacts: []
      };
      nextState = await saveRunRecord(runtime, nextState, record);
      await context.savePersistedState(nextState, "fal_run_create");

      const falClient = createConfiguredFalClient(apiKey);

      if (input.mode === "sync") {
        const result = await falClient.run(input.endpointId, { input: preparedInput });
        await writeJsonFile(responsePath, result);
        const materialized = await materializeArtifactsToWorkspace(
          result.data,
          artifactsDir,
          runtime.defaults.artifactDownloadLimit,
          runtime.defaults.downloadOutputs
        );
        record = {
          ...record,
          requestId: result.requestId,
          updatedAt: new Date().toISOString(),
          status: "COMPLETED",
          artifacts: materialized.artifacts,
          artifactIssues: materialized.artifactIssues
        };
        nextState = await saveRunRecord(runtime, nextState, record);
        await context.savePersistedState(nextState, "fal_run_sync_complete");
        return okResponse({
          ok: true,
          mode: "sync",
          status: "COMPLETED",
          workspaceId: record.workspaceId,
          runId: record.runId,
          requestId: record.requestId ?? null,
          artifacts: materialized.artifacts,
          artifactIssues: materialized.artifactIssues,
          rawResultPath: responsePath,
          result: {
            ...result,
            data: materialized.publicPayload
          }
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
          queue: enqueued
        });
      }

      const waitMs = input.waitMs ?? runtime.defaults.waitMs;
      const deadline = Date.now() + waitMs;
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
          await writeJsonFile(responsePath, result);
          const materialized = await materializeArtifactsToWorkspace(
            result.data,
            artifactsDir,
            runtime.defaults.artifactDownloadLimit,
            runtime.defaults.downloadOutputs
          );
          record = {
            ...record,
            updatedAt: new Date().toISOString(),
            status: "COMPLETED",
            artifacts: materialized.artifacts,
            artifactIssues: materialized.artifactIssues
          };
          nextState = await saveRunRecord(runtime, nextState, record);
          await context.savePersistedState(nextState, "fal_run_complete");
          return okResponse({
            ok: true,
            mode: "queue",
            status: "COMPLETED",
            workspaceId: record.workspaceId,
            runId: record.runId,
            requestId: enqueued.request_id,
            artifacts: materialized.artifacts,
            artifactIssues: materialized.artifactIssues,
            rawResultPath: responsePath,
            result: {
              ...result,
              data: materialized.publicPayload
            }
          });
        }
        await sleep(runtime.defaults.pollIntervalMs);
      }

      await writeFile(path.join(runDirectory, "timeout.txt"), `Timed out after ${waitMs}ms\n`);
      return okResponse({
        ok: true,
        mode: "queue",
        status: "PENDING",
        workspaceId: record.workspaceId,
        runId: record.runId,
        requestId: enqueued.request_id,
        latestStatus
      });
    }
  );
}
