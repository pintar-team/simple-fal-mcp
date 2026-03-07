import { z } from "zod";

import { createConfiguredFalClient, falApiRequest } from "../../fal/client.js";
import { parseRequestHistoryResponse, summarizeRequestHistoryItem } from "../../fal/models.js";
import { buildPublicResultPayload, materializeArtifactsToWorkspace } from "../../fal/result.js";
import { findRunRecord, loadRunRecord, saveRunRecord } from "../../fal/workspaces.js";
import { getFalApiKey } from "../../runtime.js";
import { readJsonFile, writeJsonFile } from "../../runtime/files.js";
import type { PersistedState, RunRecord, SavedRequestHistorySession } from "../../runtime.js";
import { okResponse, type FalToolContext } from "../shared.js";

const requestSchema = z.object({
  action: z.enum(["status", "result", "cancel", "history", "history_next"]),
  endpointId: z.string().optional(),
  requestId: z.string().optional(),
  workspaceId: z.string().optional(),
  runId: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.number().int().positive().max(50).optional(),
  expandPayloads: z.boolean().optional()
});

async function resolveRunReference(context: FalToolContext, input: z.infer<typeof requestSchema>): Promise<RunRecord | null> {
  const runtime = context.getRuntime();
  if (input.workspaceId && input.runId) {
    return loadRunRecord(runtime, input.workspaceId, input.runId);
  }
  if (input.runId) {
    return findRunRecord(runtime, context.getPersistedState(), input.runId);
  }
  return null;
}

function withUpdatedState(base: PersistedState, nextRecord: RunRecord): PersistedState {
  return {
    ...base,
    workspaces: {
      items: base.workspaces?.items ?? [],
      lastWorkspaceId: nextRecord.workspaceId,
      lastRunId: nextRecord.runId
    }
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : null;
}

function sanitizeCachedResult(
  result: unknown,
  localRun: RunRecord
): Record<string, unknown> {
  if (result && typeof result === "object" && "data" in (result as Record<string, unknown>)) {
    const record = result as Record<string, unknown>;
    return {
      result: {
        ...record,
        data: buildPublicResultPayload(record.data, localRun.artifacts, localRun.artifactIssues ?? [])
      }
    };
  }

  return {
    result
  };
}

export function registerFalRequestTool(context: FalToolContext): void {
  context.server.registerTool(
    "fal_request",
    {
      title: "fal request follow-up",
      description: "Inspect queue status, fetch results, cancel a queued fal request, or list recent platform requests by endpoint.",
      inputSchema: requestSchema
    },
    async input => {
      await context.reloadRuntime("fal_request");
      const apiKey = getFalApiKey(context.getAuth());
      const runtime = context.getRuntime();

      if (input.action === "history" || input.action === "history_next") {
        if (!apiKey) {
          throw new Error("fal_request history actions require FAL_KEY.");
        }
        const previous = context.getPersistedState().requests?.lastHistory;
        const endpointId = input.action === "history_next"
          ? previous?.endpointId
          : input.endpointId;
        if (!endpointId) {
          throw new Error("fal_request action=history requires endpointId.");
        }
        const limit = input.limit ?? previous?.limit ?? runtime.defaults.modelSearchLimit;
        const cursor = input.action === "history_next"
          ? (input.cursor ?? previous?.nextCursor)
          : input.cursor;
        if (input.action === "history_next" && !cursor) {
          throw new Error("No saved request-history cursor is available. Run fal_request action=history first.");
        }
        const expandPayloads = input.expandPayloads ?? previous?.expandPayloads ?? false;
        const body = await falApiRequest<unknown>("models/requests/by-endpoint", {
          apiKey,
          query: {
            endpoint_id: endpointId,
            limit,
            cursor,
            expand_payloads: expandPayloads
          }
        });
        const parsed = parseRequestHistoryResponse(body);
        const session: SavedRequestHistorySession = {
          savedAt: new Date().toISOString(),
          endpointId,
          limit,
          cursor,
          nextCursor: parsed.nextCursor,
          hasMore: parsed.hasMore,
          expandPayloads,
          items: parsed.items.map(item => summarizeRequestHistoryItem(item, endpointId))
        };
        await context.savePersistedState({
          ...context.getPersistedState(),
          requests: {
            lastHistory: session
          }
        }, "fal_request_history");
        return okResponse({
          ok: true,
          action: input.action,
          endpointId,
          count: session.items.length,
          hasMore: parsed.hasMore,
          nextCursor: parsed.nextCursor ?? null,
          items: parsed.items
        });
      }

      const localRun = await resolveRunReference(context, input);
      const endpointId = input.endpointId ?? localRun?.endpointId;
      const requestId = input.requestId ?? localRun?.requestId;

      if (!endpointId) {
        throw new Error("fal_request requires endpointId or a saved runId.");
      }
      if (input.action !== "cancel" && input.action !== "result" && input.action !== "status") {
        throw new Error("Unsupported fal_request action.");
      }

      if (!apiKey) {
        if (localRun && input.action === "result" && localRun.responsePath) {
          const cached = await readJsonFile<unknown>(localRun.responsePath).catch(() => null);
          return okResponse({
            ok: true,
            action: "result",
            source: "local_cache",
            run: localRun,
            rawResultPath: localRun.responsePath,
            artifactIssues: localRun.artifactIssues ?? [],
            artifacts: localRun.artifacts,
            ...sanitizeCachedResult(cached, localRun)
          });
        }
        throw new Error(`fal_request action=${input.action} requires FAL_KEY unless a cached local result is available.`);
      }

      const falClient = createConfiguredFalClient(apiKey);
      if (input.action === "cancel") {
        if (!requestId) {
          throw new Error("fal_request action=cancel requires requestId or a saved queue run.");
        }
        await falClient.queue.cancel(endpointId, { requestId });
        return okResponse({
          ok: true,
          action: "cancel",
          endpointId,
          requestId
        });
      }

      if (input.action === "status") {
        if (!requestId) {
          if (localRun) {
            return okResponse({
              ok: true,
              action: "status",
              source: "local_run",
              run: localRun
            });
          }
          throw new Error("fal_request action=status requires requestId or a saved queue run.");
        }
        const status = await falClient.queue.status(endpointId, {
          requestId,
          logs: true
        });
        if (localRun?.statusPath) {
          await writeJsonFile(localRun.statusPath, status);
          const updated: RunRecord = {
            ...localRun,
            updatedAt: new Date().toISOString(),
            status: status.status
          };
          const nextState = await saveRunRecord(runtime, withUpdatedState(context.getPersistedState(), updated), updated);
          await context.savePersistedState(nextState, "fal_request_status");
        }
        return okResponse({
          ok: true,
          action: "status",
          endpointId,
          requestId,
          status
        });
      }

      if (!requestId) {
        if (localRun?.responsePath) {
          const cached = await readJsonFile<unknown>(localRun.responsePath).catch(() => null);
          return okResponse({
            ok: true,
            action: "result",
            source: "local_cache",
            run: localRun,
            rawResultPath: localRun.responsePath,
            artifactIssues: localRun.artifactIssues ?? [],
            artifacts: localRun.artifacts,
            ...sanitizeCachedResult(cached, localRun)
          });
        }
        throw new Error("fal_request action=result requires requestId or a saved completed run.");
      }

      const result = await falClient.queue.result(endpointId, { requestId });
      if (localRun?.responsePath) {
        await writeJsonFile(localRun.responsePath, result);
        const resultRecord = asRecord(result);
        const materialized = localRun.artifactsDir
          ? await materializeArtifactsToWorkspace(
              resultRecord?.data,
              localRun.artifactsDir,
              runtime.defaults.artifactDownloadLimit,
              runtime.defaults.downloadOutputs
            )
          : {
              artifacts: localRun.artifacts,
              artifactIssues: localRun.artifactIssues ?? [],
              publicPayload: resultRecord?.data
            };
        const updated: RunRecord = {
          ...localRun,
          updatedAt: new Date().toISOString(),
          status: "COMPLETED",
          artifacts: materialized.artifacts,
          artifactIssues: materialized.artifactIssues
        };
        const nextState = await saveRunRecord(runtime, withUpdatedState(context.getPersistedState(), updated), updated);
        await context.savePersistedState(nextState, "fal_request_result");
        return okResponse({
          ok: true,
          action: "result",
          endpointId,
          requestId,
          workspaceId: localRun.workspaceId,
          runId: localRun.runId,
          artifacts: materialized.artifacts,
          artifactIssues: materialized.artifactIssues,
          rawResultPath: localRun.responsePath,
          result: resultRecord
            ? {
                ...resultRecord,
                data: materialized.publicPayload
              }
            : result
        });
      }

      return okResponse({
        ok: true,
        action: "result",
        endpointId,
        requestId,
        result: (() => {
          const resultRecord = asRecord(result);
          if (!resultRecord || !("data" in resultRecord)) {
            return result;
          }
          return {
            ...resultRecord,
            data: buildPublicResultPayload(resultRecord.data)
          };
        })()
      });
    }
  );
}
