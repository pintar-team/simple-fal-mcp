import { parseRequestHistoryResponse, summarizeRequestHistoryItem } from "./models.js";
import { FalApiError, falApiRequest } from "./client.js";
import { readJsonFile } from "../runtime/files.js";
import type {
  RunRecord,
  SavedRequestHistoryItem,
  SavedUsageItem
} from "../runtime.js";

type JsonRecord = Record<string, unknown>;

export type ParsedPriceRecord = {
  endpointId: string;
  unitPrice?: number;
  unit?: string;
  currency?: string;
  raw: JsonRecord;
};

export type ParsedEstimate = {
  estimateType?: string;
  totalCost?: number;
  currency?: string;
  raw: unknown;
};

export type ParsedUsageResponse = {
  items: SavedUsageItem[];
  summary?: SavedUsageItem | null;
  nextCursor?: string;
  hasMore: boolean;
  raw: unknown;
};

export type ParsedRequestRecord = SavedRequestHistoryItem & {
  startedAt?: string;
  raw: JsonRecord;
};

export type InferredQuantity = {
  quantity: number;
  source: string;
};

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(record: JsonRecord | null, keys: string[]): string | undefined {
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }
  return undefined;
}

function readNumber(record: JsonRecord | null, keys: string[]): number | undefined {
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

function pickArray(body: unknown, keys: string[]): unknown[] {
  if (Array.isArray(body)) {
    return body;
  }
  const record = asRecord(body);
  for (const key of keys) {
    const value = record?.[key];
    if (Array.isArray(value)) {
      return value;
    }
  }
  return [];
}

function parseUsageItem(record: JsonRecord): SavedUsageItem {
  return {
    endpointId: readString(record, ["endpoint_id", "endpointId", "model_id", "path"]),
    startDate: readString(record, ["start_date", "startDate", "bucket_start", "from"]),
    endDate: readString(record, ["end_date", "endDate", "bucket_end", "to"]),
    authMethod: readString(record, ["auth_method", "authMethod"]),
    granularity: readString(record, ["granularity", "timeframe"]),
    quantity: readNumber(record, ["quantity", "unit_quantity"]),
    unit: readString(record, ["unit"]),
    unitPrice: readNumber(record, ["unit_price", "unitPrice"]),
    cost: readNumber(record, ["cost", "total_cost", "totalCost"]),
    currency: readString(record, ["currency"])
  };
}

function buildEndpointQuery(endpointIds: string[]): string {
  const query = new URLSearchParams();
  endpointIds.forEach(id => query.append("endpoint_id", id));
  return query.toString();
}

export function normalizeEndpointIds(input: {
  endpointId?: string;
  endpointIds?: string[];
}): string[] {
  return Array.from(new Set([
    ...(input.endpointId ? [input.endpointId] : []),
    ...(input.endpointIds ?? [])
  ].map(item => item.trim()).filter(Boolean)));
}

export async function fetchPricingRecords(
  apiKey: string | undefined,
  endpointIds: string[]
): Promise<{ items: ParsedPriceRecord[]; raw: unknown }> {
  if (endpointIds.length === 0) {
    return { items: [], raw: { prices: [] } };
  }

  const raw = await falApiRequest<unknown>("models/pricing", {
    apiKey,
    query: Object.fromEntries(endpointIds.map((id, index) => [`endpoint_id_${index}`, id]))
  }).catch(async () => {
    const query = buildEndpointQuery(endpointIds);
    return falApiRequest<unknown>(`models/pricing?${query}`, { apiKey });
  });

  const prices = pickArray(raw, ["prices", "items", "data", "results"])
    .map(asRecord)
    .filter((item): item is JsonRecord => Boolean(item))
    .map(item => ({
      endpointId: readString(item, ["endpoint_id", "endpointId", "model_id", "id"]) ?? "unknown",
      unitPrice: readNumber(item, ["unit_price", "unitPrice"]),
      unit: readString(item, ["unit"]),
      currency: readString(item, ["currency"]),
      raw: item
    }));

  return {
    items: prices,
    raw
  };
}

export async function estimateEndpointCost(
  apiKey: string,
  endpoints: Array<{ endpointId: string; unitQuantity?: number; callQuantity?: number }>,
  estimateType: "unit_price" | "historical_api_price"
): Promise<ParsedEstimate> {
  const payload = {
    estimate_type: estimateType,
    endpoints: Object.fromEntries(
      endpoints.map(item => [
        item.endpointId,
        {
          unit_quantity: item.unitQuantity,
          call_quantity: item.callQuantity
        }
      ])
    )
  };
  const raw = await falApiRequest<unknown>("models/pricing/estimate", {
    apiKey,
    method: "POST",
    body: payload
  });
  const record = asRecord(raw);
  return {
    estimateType: readString(record, ["estimate_type", "estimateType"]),
    totalCost: readNumber(record, ["total_cost", "totalCost", "cost"]),
    currency: readString(record, ["currency"]),
    raw
  };
}

export function parseUsageResponse(raw: unknown): ParsedUsageResponse {
  const record = asRecord(raw);
  const items = pickArray(raw, ["time_series", "items", "data", "results"])
    .map(asRecord)
    .filter((item): item is JsonRecord => Boolean(item))
    .map(parseUsageItem);

  const summarySource = asRecord(record?.summary)
    ?? asRecord(asArray(record?.summary)[0]);
  const summary = summarySource
    ? parseUsageItem(summarySource)
    : undefined;

  const nextCursor = readString(record, ["next_cursor", "nextCursor", "cursor"]);
  const hasMoreValue = record?.has_more ?? record?.hasMore;
  const hasMore = typeof hasMoreValue === "boolean"
    ? hasMoreValue
    : Boolean(nextCursor);

  return {
    items,
    summary,
    nextCursor,
    hasMore,
    raw
  };
}

export async function fetchUsageReport(
  apiKey: string,
  options: {
    endpointIds?: string[];
    startDate?: string;
    endDate?: string;
    granularity?: "minute" | "hour" | "day";
    cursor?: string;
    mode?: "summary" | "time_series" | "both";
    authMethod?: string;
  }
): Promise<ParsedUsageResponse> {
  const query = new URLSearchParams();
  (options.endpointIds ?? []).forEach(id => query.append("endpoint_id", id));
  if (options.startDate) query.set("start_date", options.startDate);
  if (options.endDate) query.set("end_date", options.endDate);
  if (options.granularity) query.set("granularity", options.granularity);
  if (options.cursor) query.set("cursor", options.cursor);
  if (options.authMethod) query.set("auth_method", options.authMethod);
  query.set("bound_to_timeframe", "false");

  const mode = options.mode ?? "both";
  if (mode === "summary" || mode === "both") {
    query.append("expand", "summary");
  }
  if (mode === "time_series" || mode === "both") {
    query.append("expand", "time_series");
  }

  const raw = await falApiRequest<unknown>(`models/usage?${query.toString()}`, { apiKey });
  return parseUsageResponse(raw);
}

export async function fetchRequestHistoryRecords(
  apiKey: string,
  options: {
    endpointId: string;
    requestId?: string;
    limit?: number;
    cursor?: string;
    expandPayloads?: boolean;
  }
): Promise<{ items: ParsedRequestRecord[]; nextCursor?: string; hasMore: boolean; raw: unknown }> {
  const query = new URLSearchParams();
  query.set("endpoint_id", options.endpointId);
  if (options.requestId) {
    query.set("request_id", options.requestId);
  }
  if (options.limit) {
    query.set("limit", String(options.limit));
  }
  if (options.cursor) {
    query.set("cursor", options.cursor);
  }
  if (options.expandPayloads) {
    query.set("expand_payloads", "true");
  }

  let raw: unknown;
  try {
    raw = await falApiRequest<unknown>(`models/requests/by-endpoint?${query.toString()}`, { apiKey });
  } catch (error) {
    const shouldFallback = error instanceof FalApiError
      && options.requestId
      && error.status >= 400
      && error.status < 500;
    if (!shouldFallback) {
      throw error;
    }
    const fallback = new URLSearchParams(query);
    fallback.delete("request_id");
    raw = await falApiRequest<unknown>(`models/requests/by-endpoint?${fallback.toString()}`, { apiKey });
  }

  const parsed = parseRequestHistoryResponse(raw);
  const items = parsed.items.map(item => ({
    ...summarizeRequestHistoryItem(item, options.endpointId),
    startedAt: readString(item, ["started_at", "startedAt"]),
    raw: item
  })).filter(item => options.requestId ? item.requestId === options.requestId : true);

  return {
    items,
    nextCursor: parsed.nextCursor,
    hasMore: parsed.hasMore,
    raw
  };
}

function readNumberish(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function inferSecondsFromMultiPrompt(value: unknown): number | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  let total = 0;
  let found = false;
  for (const item of value) {
    const record = asRecord(item);
    const duration = readNumberish(record?.duration);
    if (duration !== undefined) {
      total += duration;
      found = true;
    }
  }
  return found ? total : undefined;
}

export function inferUsageQuantity(input: unknown, unit: string | undefined): InferredQuantity | undefined {
  const record = asRecord(input);
  const normalizedUnit = unit?.toLowerCase();

  if (normalizedUnit === "seconds" || normalizedUnit === "second") {
    const direct = readNumberish(record?.duration)
      ?? readNumberish(record?.durationSeconds)
      ?? inferSecondsFromMultiPrompt(record?.multi_prompt)
      ?? inferSecondsFromMultiPrompt(record?.multiPrompt);
    if (direct !== undefined) {
      return {
        quantity: direct,
        source: "input.duration"
      };
    }
  }

  if (normalizedUnit === "images" || normalizedUnit === "image") {
    const count = readNumberish(record?.num_images)
      ?? readNumberish(record?.numImages)
      ?? readNumberish(record?.image_count)
      ?? 1;
    return {
      quantity: count,
      source: count === 1 ? "default.single_image" : "input.num_images"
    };
  }

  if (normalizedUnit === "calls" || normalizedUnit === "call" || normalizedUnit === "requests" || normalizedUnit === "request") {
    return {
      quantity: 1,
      source: "default.single_call"
    };
  }

  const explicit = readNumberish(record?.quantity)
    ?? readNumberish(record?.count)
    ?? readNumberish(record?.unit_quantity);
  if (explicit !== undefined) {
    return {
      quantity: explicit,
      source: "input.quantity"
    };
  }

  return undefined;
}

export function buildRequestUsageWindow(item: {
  sentAt?: string;
  startedAt?: string;
  endedAt?: string;
}): { startDate: string; endDate: string } | null {
  const startDate = item.sentAt ?? item.startedAt;
  const endDate = item.endedAt ?? item.sentAt ?? item.startedAt;
  if (!startDate || !endDate) {
    return null;
  }
  const startMs = Date.parse(startDate);
  const endMs = Date.parse(endDate);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return null;
  }
  if (endMs >= startMs) {
    return { startDate, endDate };
  }
  return { startDate: endDate, endDate: startDate };
}

export async function loadRunInputPayload(run: RunRecord): Promise<Record<string, unknown> | null> {
  if (!run.inputPath) {
    return null;
  }
  const payload = await readJsonFile<unknown>(run.inputPath).catch(() => null);
  const record = asRecord(payload);
  const input = asRecord(record?.input);
  return input ?? record;
}
