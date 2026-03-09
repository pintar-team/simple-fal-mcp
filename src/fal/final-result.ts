import { ApiError, ValidationError, type FalClient, type QueueStatus } from "@fal-ai/client";

import { writeJsonFile } from "../runtime/files.js";
import type { PersistedState, RunFailureRecord, RunRecord, RuntimeConfig } from "../runtime.js";
import { getFalFetch } from "./client.js";
import { saveRunRecord } from "./workspaces.js";

type JsonRecord = Record<string, unknown>;

type ResponseUrlResult = {
  ok: boolean;
  status: number;
  statusText: string;
  requestId?: string;
  body: unknown;
};

type QueueResultSuccess = {
  kind: "success";
  result: unknown;
};

type QueueResultFailure = {
  kind: "provider_failure";
  failure: RunFailureRecord;
  responseBody: Record<string, unknown>;
};

export type QueueResultOutcome = QueueResultSuccess | QueueResultFailure;

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : null;
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

function detailMessagesFromValue(value: unknown): string[] {
  if (typeof value === "string" && value.trim() !== "") {
    return [value.trim()];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap(item => {
    if (typeof item === "string" && item.trim() !== "") {
      return [item.trim()];
    }
    const record = asRecord(item);
    const message = readString(record, ["msg", "message", "error", "detail"]);
    return message ? [message] : [];
  });
}

function extractErrorMessage(body: unknown): string | undefined {
  if (typeof body === "string" && body.trim() !== "") {
    return body.trim();
  }

  const record = asRecord(body);
  if (!record) {
    return undefined;
  }

  const direct = readString(record, ["error", "message", "detail", "reason"]);
  if (direct) {
    return direct;
  }

  const detailMessages = detailMessagesFromValue(record.detail);
  if (detailMessages.length > 0) {
    return detailMessages.join("; ");
  }

  const payloadMessage = extractErrorMessage(record.payload);
  if (payloadMessage) {
    return payloadMessage;
  }

  const nestedError = extractErrorMessage(record.error);
  if (nestedError) {
    return nestedError;
  }

  return undefined;
}

function extractDetailMessages(body: unknown): string[] | undefined {
  const record = asRecord(body);
  if (!record) {
    return undefined;
  }
  const messages = detailMessagesFromValue(record.detail);
  return messages.length > 0 ? messages : undefined;
}

function inferErrorType(error: unknown, body: unknown): string | undefined {
  if (error instanceof ValidationError) {
    return "validation_error";
  }
  if (error instanceof ApiError) {
    return "api_error";
  }

  const record = asRecord(body);
  return readString(record, ["type", "error_type"]);
}

function isMeaningfulMessage(message: string | undefined): boolean {
  if (!message) {
    return false;
  }
  const normalized = message.trim().toLowerCase();
  return normalized !== "" && normalized !== "unprocessable entity" && normalized !== "bad request";
}

async function fetchResponseUrl(url: string, apiKey: string): Promise<ResponseUrlResult | null> {
  try {
    const response = await getFalFetch()(url, {
      headers: {
        Authorization: `Key ${apiKey}`
      }
    });
    const contentType = response.headers.get("Content-Type") ?? "";
    const requestId = response.headers.get("x-fal-request-id") ?? undefined;
    let body: unknown;
    if (contentType.includes("application/json")) {
      body = await response.json().catch((): unknown => null);
    } else {
      body = await response.text().catch(() => "");
    }
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      requestId,
      body
    };
  } catch {
    return null;
  }
}

export function buildProviderFailure(
  error: unknown,
  requestId: string,
  latestStatus?: QueueStatus,
  fallbackResponse?: ResponseUrlResult | null
): { failure: RunFailureRecord; responseBody: Record<string, unknown> } {
  const sdkBody: unknown = error instanceof ApiError ? error.body : undefined;
  const providerBody: unknown = fallbackResponse?.body ?? sdkBody;
  const message = extractErrorMessage(providerBody)
    ?? (error instanceof Error ? error.message : String(error));
  const detailMessages = extractDetailMessages(providerBody);
  const responseRecord = asRecord(providerBody);
  const providerStatus = readString(responseRecord, ["status"]);
  const httpStatus = fallbackResponse?.status ?? (error instanceof ApiError ? error.status : undefined);
  const errorType = inferErrorType(error, providerBody);
  const responseUrl = latestStatus?.response_url;

  const failure: RunFailureRecord = {
    stage: "provider_result",
    queueStatus: latestStatus?.status,
    providerStatus,
    httpStatus,
    errorType,
    message,
    requestId,
    responseUrl,
    detailMessages
  };

  return {
    failure,
    responseBody: {
      status: "ERROR",
      source: "provider_result",
      requestId,
      queueStatus: latestStatus?.status ?? null,
      providerStatus: providerStatus ?? null,
      responseUrl: responseUrl ?? null,
      httpStatus: httpStatus ?? null,
      errorType: errorType ?? null,
      message,
      detailMessages: detailMessages ?? [],
      providerResponse: providerBody ?? null
    }
  };
}

export async function fetchQueueResultOutcome(options: {
  apiKey: string;
  falClient: FalClient;
  endpointId: string;
  requestId: string;
  latestStatus?: QueueStatus;
}): Promise<QueueResultOutcome> {
  try {
    const result = await options.falClient.queue.result(options.endpointId, {
      requestId: options.requestId
    });
    return {
      kind: "success",
      result
    };
  } catch (error) {
    const fallbackResponse = options.latestStatus?.response_url
      ? await fetchResponseUrl(options.latestStatus.response_url, options.apiKey)
      : null;
    const normalized = buildProviderFailure(
      error,
      options.requestId,
      options.latestStatus,
      fallbackResponse
    );

    if (fallbackResponse?.ok && asRecord(fallbackResponse.body)) {
      return {
        kind: "success",
        result: {
          data: fallbackResponse.body,
          requestId: fallbackResponse.requestId ?? options.requestId
        }
      };
    }

    if (error instanceof ApiError && isMeaningfulMessage(normalized.failure.message)) {
      return {
        kind: "provider_failure",
        ...normalized
      };
    }

    if (fallbackResponse) {
      return {
        kind: "provider_failure",
        ...normalized
      };
    }

    throw error;
  }
}

export async function materializeRunFailure(
  runtime: RuntimeConfig,
  state: PersistedState,
  run: RunRecord,
  failure: RunFailureRecord,
  responseBody: Record<string, unknown>
): Promise<{
  nextState: PersistedState;
  updatedRun: RunRecord;
  rawResultPath: string | null;
}> {
  if (run.responsePath) {
    await writeJsonFile(run.responsePath, responseBody);
  }

  const updatedRun: RunRecord = {
    ...run,
    updatedAt: new Date().toISOString(),
    status: "FAILED",
    error: failure.message,
    providerFailure: failure
  };
  const nextState = await saveRunRecord(runtime, state, updatedRun);

  return {
    nextState,
    updatedRun,
    rawResultPath: updatedRun.responsePath ?? null
  };
}
