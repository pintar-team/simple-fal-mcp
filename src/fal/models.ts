import type { SavedModelSummary, SavedRequestHistoryItem } from "../runtime.js";

type JsonRecord = Record<string, unknown>;

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

export function parseModelListResponse(body: unknown): {
  items: JsonRecord[];
  nextCursor?: string;
  hasMore: boolean;
} {
  const record = asRecord(body);
  const items = pickArray(body, ["models", "items", "data", "results"])
    .map(asRecord)
    .filter((item): item is JsonRecord => Boolean(item));
  const nextCursor = readString(record, ["next_cursor", "nextCursor", "cursor"]);
  const hasMoreValue = record?.has_more ?? record?.hasMore;
  const hasMore = typeof hasMoreValue === "boolean"
    ? hasMoreValue
    : Boolean(nextCursor);
  return { items, nextCursor, hasMore };
}

export function parseRequestHistoryResponse(body: unknown): {
  items: JsonRecord[];
  nextCursor?: string;
  hasMore: boolean;
} {
  const record = asRecord(body);
  const items = pickArray(body, ["requests", "items", "data", "results"])
    .map(asRecord)
    .filter((item): item is JsonRecord => Boolean(item));
  const nextCursor = readString(record, ["next_cursor", "nextCursor", "cursor"]);
  const hasMoreValue = record?.has_more ?? record?.hasMore;
  const hasMore = typeof hasMoreValue === "boolean"
    ? hasMoreValue
    : Boolean(nextCursor);
  return { items, nextCursor, hasMore };
}

export function summarizeModel(record: JsonRecord): SavedModelSummary {
  const provider = readString(record, ["provider", "provider_id", "owner"]);
  const displayName = readString(record, ["title", "name", "display_name"]);
  const category = readString(record, ["category", "task", "type"]);
  const status = readString(record, ["status", "release_status"]);
  const endpointId = readString(record, ["endpoint_id", "endpointId", "model_id", "id"]) ?? "unknown";
  return {
    endpointId,
    displayName,
    category,
    status,
    provider
  };
}

export function summarizeRequestHistoryItem(record: JsonRecord, fallbackEndpointId?: string): SavedRequestHistoryItem {
  const requestId = readString(record, ["request_id", "requestId", "id"]) ?? "unknown";
  const endpointId = readString(record, ["endpoint_id", "endpointId", "model_id", "path"]) ?? fallbackEndpointId ?? "unknown";
  return {
    requestId,
    endpointId,
    sentAt: readString(record, ["sent_at", "created_at", "createdAt"]),
    endedAt: readString(record, ["ended_at", "finished_at", "endedAt"]),
    statusCode: readNumber(record, ["status_code", "statusCode"]),
    duration: readNumber(record, ["duration", "duration_ms", "durationMs"])
  };
}

type OpenApiRecord = Record<string, unknown>;

function resolveRef(root: OpenApiRecord, value: unknown): unknown {
  const record = asRecord(value);
  const ref = readString(record, ["$ref"]);
  if (!ref || !ref.startsWith("#/")) {
    return value;
  }
  const parts = ref.slice(2).split("/");
  let current: unknown = root;
  for (const part of parts) {
    const decoded = decodeURIComponent(part.replace(/~1/g, "/").replace(/~0/g, "~"));
    current = asRecord(current)?.[decoded];
  }
  return current ?? value;
}

function summarizeSchemaNode(root: OpenApiRecord, schema: unknown, depth = 0): unknown {
  if (depth > 4) {
    return { type: "object", note: "nested summary truncated" };
  }

  const resolved = resolveRef(root, schema);
  const record = asRecord(resolved);
  if (!record) {
    return undefined;
  }

  const oneOf = asArray(record.oneOf);
  if (oneOf.length > 0) {
    return {
      oneOf: oneOf
        .map(item => summarizeSchemaNode(root, item, depth + 1))
        .filter(Boolean)
    };
  }

  const anyOf = asArray(record.anyOf);
  if (anyOf.length > 0) {
    return {
      anyOf: anyOf
        .map(item => summarizeSchemaNode(root, item, depth + 1))
        .filter(Boolean)
    };
  }

  const type = readString(record, ["type"]);
  const description = readString(record, ["description", "title"]);
  const format = readString(record, ["format"]);
  const enumValues = Array.isArray(record.enum) ? record.enum.slice(0, 8) : undefined;

  if (type === "object" || record.properties) {
    const properties = asRecord(record.properties) ?? {};
    const required = Array.isArray(record.required)
      ? record.required.filter((item): item is string => typeof item === "string")
      : [];
    const fieldEntries = Object.entries(properties).slice(0, 16).map(([key, value]) => {
      const child = summarizeSchemaNode(root, value, depth + 1);
      return [key, child] as const;
    });
    return {
      type: "object",
      description,
      required,
      properties: Object.fromEntries(fieldEntries)
    };
  }

  if (type === "array" || record.items) {
    return {
      type: "array",
      description,
      items: summarizeSchemaNode(root, record.items, depth + 1)
    };
  }

  return {
    type: type ?? "unknown",
    description,
    format,
    enum: enumValues
  };
}

function extractOpenApiSpec(record: JsonRecord): OpenApiRecord | null {
  const candidates = [
    record.openapi,
    record["openapi-3.0"],
    record.openapi_3_0,
    asRecord(record.schema)?.openapi,
    asRecord(record.payloads)?.openapi
  ];
  for (const candidate of candidates) {
    const resolved = asRecord(candidate);
    if (resolved) {
      return resolved;
    }
  }
  return null;
}

export function buildModelDetail(record: JsonRecord, schemaMode: "summary" | "openapi" | "both" = "summary"): Record<string, unknown> {
  const summary = summarizeModel(record);
  const openapi = extractOpenApiSpec(record);

  let schemaSummary: Record<string, unknown> | undefined;
  if (openapi) {
    const paths = asRecord(openapi.paths) ?? {};
    const firstPath = Object.values(paths).map(asRecord).find(Boolean) ?? null;
    const postMethod = asRecord(firstPath?.post) ?? asRecord(firstPath?.get) ?? null;
    const requestBody = asRecord(postMethod?.requestBody);
    const requestContent = asRecord(asRecord(requestBody?.content)?.["application/json"]);
    const requestSchema = requestContent?.schema;

    const responses = asRecord(postMethod?.responses) ?? {};
    const responseEntry = asRecord(responses["200"] ?? responses.default);
    const responseContent = asRecord(asRecord(responseEntry?.content)?.["application/json"]);
    const responseSchema = responseContent?.schema;

    schemaSummary = {
      input: summarizeSchemaNode(openapi, requestSchema),
      output: summarizeSchemaNode(openapi, responseSchema)
    };
  }

  return {
    summary,
    raw: schemaMode === "summary" ? record : undefined,
    schemaSummary,
    openapi: schemaMode === "openapi" || schemaMode === "both" ? openapi : undefined
  };
}
