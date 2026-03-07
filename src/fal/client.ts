import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import { createFalClient } from "@fal-ai/client";

import type { RuntimeConfig } from "../runtime.js";
import { createFetchWithDuplex } from "./fetch.js";

const REST_BASE_URL = "https://api.fal.ai/v1";

export class FalApiError extends Error {
  readonly status: number;
  readonly body: string | undefined;

  constructor(status: number, statusText: string, body?: string) {
    super(`fal API request failed: ${status} ${statusText}${body ? ` - ${body}` : ""}`);
    this.name = "FalApiError";
    this.status = status;
    this.body = body;
  }
}

type RequestOptions = {
  apiKey?: string;
  method?: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
};

function buildHeaders(apiKey?: string, extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  if (apiKey) {
    headers.set("Authorization", `Key ${apiKey}`);
  }
  return headers;
}

function buildUrl(pathname: string, query?: RequestOptions["query"]): string {
  const url = new URL(pathname, `${REST_BASE_URL}/`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) {
        continue;
      }
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

export async function falApiRequest<T>(pathname: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? (options.body === undefined ? "GET" : "POST");
  const headers = buildHeaders(options.apiKey, options.body === undefined
    ? undefined
    : { "Content-Type": "application/json" });
  const init: RequestInit = {
    method,
    headers
  };
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
  }
  const response = await createFetchWithDuplex(fetch)(buildUrl(pathname, options.query), init);
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new FalApiError(response.status, response.statusText, body);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return await response.json() as T;
}

export function createConfiguredFalClient(apiKey: string) {
  return createFalClient({
    credentials: apiKey,
    fetch: createFetchWithDuplex(fetch)
  });
}

export async function uploadLocalFile(
  apiKey: string,
  runtime: RuntimeConfig,
  localPath: string
): Promise<string> {
  const client = createConfiguredFalClient(apiKey);
  const buffer = await readFile(localPath).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read input file ${localPath}: ${message}`);
  });
  const blob = new File([buffer], basename(localPath), {
    type: "application/octet-stream"
  });
  return client.storage.upload(blob, {
    lifecycle: {
      expiresIn: runtime.defaults.objectTtlSeconds
    }
  });
}
