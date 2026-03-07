import { fal, type FalClient } from "@fal-ai/client";

import { createFetchWithDuplex } from "./fetch.js";

const REST_BASE_URL = "https://api.fal.ai/v1";
let configuredFetch: typeof fetch | undefined;

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
  headers?: HeadersInit;
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
  const headers = buildHeaders(
    options.apiKey,
    options.body === undefined
      ? options.headers
      : { "Content-Type": "application/json", ...(options.headers ?? {}) }
  );
  const init: RequestInit = {
    method,
    headers
  };
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
  }
  const response = await getFalFetch()(buildUrl(pathname, options.query), init);
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new FalApiError(response.status, response.statusText, body);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return await response.json() as T;
}

function getFalFetch(): typeof fetch {
  if (!configuredFetch) {
    configuredFetch = createFetchWithDuplex(fetch);
    globalThis.fetch = configuredFetch;
  }
  return configuredFetch;
}

export function createConfiguredFalClient(apiKey: string): FalClient {
  const nextFetch = getFalFetch();
  // The SDK client is a shared singleton. Always include credentials when
  // reconfiguring it, otherwise later calls can silently clear auth state.
  fal.config({
    credentials: apiKey,
    fetch: nextFetch
  });
  return fal;
}
