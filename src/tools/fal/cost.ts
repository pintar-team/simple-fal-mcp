import { z } from "zod";

import {
  buildRequestUsageWindow,
  estimateEndpointCost,
  fetchPricingRecords,
  fetchRequestHistoryRecords,
  fetchUsageReport,
  inferUsageQuantity,
  loadRunInputPayload,
  normalizeEndpointIds,
  type ParsedPriceRecord
} from "../../fal/cost.js";
import { findRunRecord, loadRunRecord, saveRunRecord } from "../../fal/workspaces.js";
import { getFalAdminApiKey, getFalApiKey, hasFalAdminAccess } from "../../runtime.js";
import type { PersistedState, RunRecord, SavedUsageSession } from "../../runtime.js";
import { okResponse, type FalToolContext } from "../shared.js";

const costSchema = z.object({
  action: z.enum(["price", "estimate", "usage", "usage_next", "request"]).describe("price reads live unit price, estimate plans cost, usage browses admin usage buckets, request inspects one saved run or request."),
  endpointId: z.string().optional(),
  endpointIds: z.array(z.string()).optional(),
  requestId: z.string().optional(),
  runId: z.string().optional(),
  workspaceId: z.string().optional(),
  cursor: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  granularity: z.enum(["minute", "hour", "day"]).optional(),
  mode: z.enum(["summary", "time_series", "both"]).optional(),
  authMethod: z.string().optional(),
  estimateType: z.enum(["unit_price", "historical_api_price"]).optional(),
  endpoints: z.array(z.object({
    endpointId: z.string(),
    unitQuantity: z.number().nonnegative().optional(),
    callQuantity: z.number().nonnegative().optional()
  })).optional()
});

async function resolveRunReference(context: FalToolContext, input: z.infer<typeof costSchema>): Promise<RunRecord | null> {
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

function compactPrice(price: ParsedPriceRecord | undefined): Record<string, unknown> | null {
  if (!price) {
    return null;
  }
  return {
    endpointId: price.endpointId,
    unitPrice: price.unitPrice ?? null,
    unit: price.unit ?? null,
    currency: price.currency ?? null
  };
}

export function registerFalCostTool(context: FalToolContext): void {
  context.server.registerTool(
    "fal_cost",
    {
      title: "fal pricing and cost",
      description: "Read live pricing, estimate planned calls, inspect one saved run or request, and use admin-only usage reports when an admin key is configured.",
      inputSchema: costSchema
    },
    async input => {
      await context.reloadRuntime("fal_cost");
      const runtime = context.getRuntime();
      const auth = context.getAuth();
      const apiKey = getFalApiKey(auth);
      const adminApiKey = getFalAdminApiKey(auth);
      const adminAvailable = hasFalAdminAccess(auth);

      if (input.action === "price") {
        const endpointIds = normalizeEndpointIds(input);
        if (endpointIds.length === 0) {
          throw new Error("fal_cost action=price requires endpointId or endpointIds.");
        }
        const prices = await fetchPricingRecords(apiKey, endpointIds);
        return okResponse({
          ok: true,
          action: "price",
          endpointIds,
          items: prices.items.map(compactPrice),
          result: prices.raw
        });
      }

      if (!apiKey) {
        throw new Error(`fal_cost action=${input.action} requires FAL_KEY. Configure it first.`);
      }

      if (input.action === "estimate") {
        const endpoints = input.endpoints ?? [];
        if (endpoints.length === 0) {
          throw new Error("fal_cost action=estimate requires endpoints.");
        }
        const estimateType = input.estimateType ?? "unit_price";
        const estimate = await estimateEndpointCost(apiKey, endpoints, estimateType);
        return okResponse({
          ok: true,
          action: "estimate",
          estimate: estimate.raw
        });
      }

      if (input.action === "usage" || input.action === "usage_next") {
        if (!adminApiKey || !adminAvailable) {
          throw new Error("fal_cost usage actions require FAL_ADMIN_KEY. Add an admin key in setup to unlock usage-based cost reporting.");
        }
        const previous = context.getPersistedState().costs?.lastUsage;
        const endpointIds = input.action === "usage_next"
          ? (normalizeEndpointIds(input).length > 0 ? normalizeEndpointIds(input) : previous?.endpointIds ?? [])
          : normalizeEndpointIds(input);
        const startDate = input.action === "usage_next"
          ? (input.startDate ?? previous?.startDate)
          : input.startDate;
        const endDate = input.action === "usage_next"
          ? (input.endDate ?? previous?.endDate)
          : input.endDate;
        const granularity = input.action === "usage_next"
          ? (input.granularity ?? previous?.granularity ?? "day")
          : (input.granularity ?? "day");
        const mode = input.action === "usage_next"
          ? (input.mode ?? previous?.mode ?? "both")
          : (input.mode ?? "both");
        const cursor = input.action === "usage_next"
          ? (input.cursor ?? previous?.nextCursor)
          : input.cursor;

        if (input.action === "usage_next" && !cursor) {
          throw new Error("No saved usage cursor is available. Run fal_cost action=usage first.");
        }

        const usage = await fetchUsageReport(adminApiKey, {
          endpointIds,
          startDate,
          endDate,
          granularity,
          cursor,
          mode,
          authMethod: input.authMethod
        });

        const session: SavedUsageSession = {
          savedAt: new Date().toISOString(),
          endpointIds: endpointIds.length > 0 ? endpointIds : undefined,
          startDate,
          endDate,
          granularity,
          cursor,
          nextCursor: usage.nextCursor,
          hasMore: usage.hasMore,
          mode,
          items: usage.items,
          summary: usage.summary ?? null
        };
        await context.savePersistedState({
          ...context.getPersistedState(),
          costs: {
            lastUsage: session
          }
        }, "fal_cost_usage");

        return okResponse({
          ok: true,
          action: input.action,
          endpointIds: endpointIds.length > 0 ? endpointIds : null,
          startDate: startDate ?? null,
          endDate: endDate ?? null,
          granularity,
          mode,
          cursor: cursor ?? null,
          nextCursor: usage.nextCursor ?? null,
          hasMore: usage.hasMore,
          summary: usage.summary ?? null,
          count: usage.items.length,
          items: usage.items
        });
      }

      const localRun = await resolveRunReference(context, input);
      const endpointId = input.endpointId ?? localRun?.endpointId;
      const requestId = input.requestId ?? localRun?.requestId;

      if (!endpointId) {
        throw new Error("fal_cost action=request requires endpointId or a saved runId.");
      }
      if (!requestId) {
        throw new Error("fal_cost action=request requires requestId or a saved runId with a requestId.");
      }

      const warnings: string[] = [];
      const requestHistory = await fetchRequestHistoryRecords(apiKey, {
        endpointId,
        requestId,
        limit: 5
      });
      const request = requestHistory.items[0] ?? null;
      if (!request) {
        warnings.push(`No matching request-history item was returned for ${requestId}.`);
      }

      const prices = await fetchPricingRecords(apiKey, [endpointId]);
      const price = prices.items[0];

      const inputPayload = localRun ? await loadRunInputPayload(localRun) : null;
      const inferredQuantity = inputPayload && price?.unit
        ? inferUsageQuantity(inputPayload, price.unit)
        : undefined;

      let estimate:
        | { estimateType: string; totalCost?: number; currency?: string; quantity?: number; source: string }
        | null = null;
      if (inferredQuantity && price?.unit) {
        const estimateType = input.estimateType ?? "historical_api_price";
        try {
          const priced = await estimateEndpointCost(apiKey, [{
            endpointId,
            unitQuantity: inferredQuantity.quantity,
            callQuantity: 1
          }], estimateType);
          estimate = {
            estimateType,
            totalCost: priced.totalCost,
            currency: priced.currency,
            quantity: inferredQuantity.quantity,
            source: "fal.models.pricing.estimate"
          };
        } catch (error) {
          warnings.push(error instanceof Error ? error.message : String(error));
          if (price.unitPrice !== undefined) {
            estimate = {
              estimateType: "unit_price_fallback",
              totalCost: price.unitPrice * inferredQuantity.quantity,
              currency: price.currency,
              quantity: inferredQuantity.quantity,
              source: "live_unit_price"
            };
          }
        }
      }

      let usage:
        | { cost?: number; currency?: string; quantity?: number; unit?: string; unitPrice?: number; startDate?: string; endDate?: string; confidence: "usage_window" | "estimated" | "unknown" }
        | null = null;
      const usageWindow = request ? buildRequestUsageWindow(request) : null;
      if (usageWindow && adminApiKey && adminAvailable) {
        try {
          const report = await fetchUsageReport(adminApiKey, {
            endpointIds: [endpointId],
            startDate: usageWindow.startDate,
            endDate: usageWindow.endDate,
            granularity: input.granularity ?? "minute",
            mode: "summary"
          });
          if (report.summary) {
            usage = {
              cost: report.summary.cost,
              currency: report.summary.currency,
              quantity: report.summary.quantity,
              unit: report.summary.unit,
              unitPrice: report.summary.unitPrice,
              startDate: usageWindow.startDate,
              endDate: usageWindow.endDate,
              confidence: "usage_window"
            };
          }
        } catch (error) {
          warnings.push(error instanceof Error ? error.message : String(error));
        }
      } else if (!adminAvailable) {
        warnings.push("Usage-based cost lookup requires FAL_ADMIN_KEY. Returning estimate-only confidence.");
      } else {
        warnings.push("Request history did not contain a usable start/end window for usage lookup.");
      }

      const confidence = usage?.cost !== undefined
        ? "usage_window"
        : estimate?.totalCost !== undefined
          ? "estimated"
          : "unknown";

      if (localRun) {
        const updated: RunRecord = {
          ...localRun,
          updatedAt: new Date().toISOString(),
          cost: {
            updatedAt: new Date().toISOString(),
            price: price
              ? {
                  unitPrice: price.unitPrice,
                  unit: price.unit,
                  currency: price.currency
                }
              : undefined,
            estimate: estimate
              ? {
                  totalCost: estimate.totalCost,
                  currency: estimate.currency,
                  estimateType: estimate.estimateType,
                  quantity: estimate.quantity
                }
              : undefined,
            usage: usage
              ? {
                  cost: usage.cost,
                  currency: usage.currency,
                  quantity: usage.quantity,
                  unit: usage.unit,
                  unitPrice: usage.unitPrice,
                  startDate: usage.startDate,
                  endDate: usage.endDate,
                  confidence
                }
              : undefined
          }
        };
        const nextState = await saveRunRecord(runtime, withUpdatedState(context.getPersistedState(), updated), updated);
        await context.savePersistedState(nextState, "fal_cost_request");
      }

      return okResponse({
        ok: true,
        action: "request",
        endpointId,
        requestId,
        runId: localRun?.runId ?? null,
        workspaceId: localRun?.workspaceId ?? null,
        request: request
          ? {
              requestId: request.requestId,
              endpointId: request.endpointId,
              sentAt: request.sentAt ?? null,
              startedAt: request.startedAt ?? null,
              endedAt: request.endedAt ?? null,
              statusCode: request.statusCode ?? null,
              duration: request.duration ?? null
            }
          : null,
        price: compactPrice(price),
        inferredQuantity: inferredQuantity
          ? {
              quantity: inferredQuantity.quantity,
              source: inferredQuantity.source
            }
          : null,
        estimate,
        usage,
        confidence,
        warnings
      });
    }
  );
}
