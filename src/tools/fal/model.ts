import { z } from "zod";

import { falApiRequest } from "../../fal/client.js";
import { estimateEndpointCost, fetchPricingRecords, normalizeEndpointIds } from "../../fal/cost.js";
import { buildModelDetail, parseModelListResponse, summarizeModel } from "../../fal/models.js";
import { getFalApiKey } from "../../runtime.js";
import type { SavedModelSearchSession } from "../../runtime.js";
import { okResponse, type FalToolContext } from "../shared.js";

const searchActionSchema = z.object({
  action: z.enum(["search", "next", "get", "pricing", "estimate"]),
  query: z.string().optional(),
  category: z.string().optional(),
  status: z.string().optional(),
  endpointId: z.string().optional(),
  endpointIds: z.array(z.string()).optional(),
  cursor: z.string().optional(),
  limit: z.number().int().positive().max(50).optional(),
  searchMode: z.enum(["contains", "prefix", "exact"]).optional(),
  schemaMode: z.enum(["summary", "openapi", "both"]).optional(),
  estimateType: z.enum(["unit_price", "historical_api_price"]).optional(),
  endpoints: z.array(z.object({
    endpointId: z.string(),
    unitQuantity: z.number().nonnegative().optional(),
    callQuantity: z.number().nonnegative().optional()
  })).optional()
});

export function registerFalModelTool(context: FalToolContext): void {
  context.server.registerTool(
    "fal_model",
    {
      title: "fal model discovery",
      description: "Find fal endpoints, continue the saved search cursor, inspect one model, or query price and estimate data. Use schemaMode=summary first; request raw OpenAPI only when needed.",
      inputSchema: searchActionSchema
    },
    async input => {
      await context.reloadRuntime("fal_model");
      const runtime = context.getRuntime();
      const auth = context.getAuth();
      const apiKey = getFalApiKey(auth);

      if (input.action === "search" || input.action === "next") {
        const previous = context.getPersistedState().models?.lastSession;
        const limit = input.limit ?? previous?.limit ?? runtime.defaults.modelSearchLimit;
        const query = input.action === "next" ? previous?.query : input.query;
        const category = input.action === "next" ? previous?.category : input.category;
        const status = input.action === "next" ? previous?.status : input.status;
        const cursor = input.action === "next"
          ? (input.cursor ?? previous?.nextCursor)
          : input.cursor;
        if (input.action === "next" && !cursor) {
          throw new Error("No saved model cursor is available. Run fal_model with action=search first.");
        }

        const queryParams: Record<string, string | number | boolean | undefined> = {
          q: query,
          category,
          status,
          page: cursor,
          limit,
          search_mode: input.searchMode,
          expand: input.schemaMode === "openapi" || input.schemaMode === "both" ? "openapi-3.0" : undefined
        };
        const body = await falApiRequest<unknown>("models", { apiKey, query: queryParams });
        const parsed = parseModelListResponse(body);
        const items = parsed.items.map(item => ({
          ...summarizeModel(item),
          raw: input.schemaMode === "summary" ? undefined : item
        }));
        const session: SavedModelSearchSession = {
          savedAt: new Date().toISOString(),
          query,
          category,
          status,
          limit,
          cursor,
          nextCursor: parsed.nextCursor,
          hasMore: parsed.hasMore,
          items: parsed.items.map(summarizeModel)
        };
        await context.savePersistedState({
          ...context.getPersistedState(),
          models: {
            lastSession: session
          }
        }, "fal_model_search");

        return okResponse({
          ok: true,
          action: input.action,
          query: query ?? null,
          category: category ?? null,
          status: status ?? null,
          limit,
          cursor: cursor ?? null,
          nextCursor: parsed.nextCursor ?? null,
          hasMore: parsed.hasMore,
          count: items.length,
          items
        });
      }

      if (input.action === "get") {
        const endpointIds = normalizeEndpointIds(input);
        if (endpointIds.length === 0) {
          throw new Error("fal_model action=get requires endpointId or endpointIds.");
        }
        const expand = input.schemaMode === "openapi" || input.schemaMode === "both" ? "openapi-3.0" : undefined;
        const details = [];
        for (const endpointId of endpointIds) {
          const body = await falApiRequest<unknown>("models", {
            apiKey,
            query: {
              endpoint_id: endpointId,
              limit: 1,
              expand
            }
          });
          const parsed = parseModelListResponse(body);
          const model = parsed.items[0];
          if (!model) {
            details.push({ endpointId, found: false });
            continue;
          }
          details.push({
            endpointId,
            found: true,
            ...buildModelDetail(model, input.schemaMode)
          });
        }
        return okResponse({
          ok: true,
          action: "get",
          count: details.length,
          items: details
        });
      }

      if (input.action === "pricing") {
        const endpointIds = normalizeEndpointIds(input);
        if (endpointIds.length === 0) {
          throw new Error("fal_model action=pricing requires endpointId or endpointIds.");
        }
        const prices = await fetchPricingRecords(apiKey, endpointIds);
        return okResponse({
          ok: true,
          action: "pricing",
          endpointIds,
          result: prices.raw,
          items: prices.items
        });
      }

      if (!apiKey) {
        throw new Error("fal pricing estimates require FAL_KEY. Configure it before fal_model action=estimate.");
      }
      if (input.action === "estimate") {
        const endpoints = input.endpoints ?? [];
        if (endpoints.length === 0) {
          throw new Error("fal_model action=estimate requires endpoints.");
        }
        const estimateType = input.estimateType ?? "unit_price";
        const estimate = await estimateEndpointCost(apiKey, endpoints, estimateType);
        return okResponse({
          ok: true,
          action: "estimate",
          estimate: estimate.raw
        });
      }

      throw new Error("Unsupported fal_model action.");
    }
  );
}
