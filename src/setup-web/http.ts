import type { IncomingMessage, ServerResponse } from "node:http";

export class SetupWebRequestError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "SetupWebRequestError";
    this.statusCode = statusCode;
  }
}

export function getQuerySetupToken(url: URL): string | undefined {
  return url.searchParams.get("token") ?? undefined;
}

export function getHeaderSetupToken(req: IncomingMessage): string | undefined {
  const header = req.headers["x-setup-token"];
  return typeof header === "string" && header.trim() !== "" ? header : undefined;
}

export function isValidSetupToken(submitted: string | undefined, expected: string): boolean {
  return typeof submitted === "string" && submitted === expected;
}

export async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function parseJsonBody(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new SetupWebRequestError(400, `Invalid JSON body: ${message}`);
  }
}

export function writeNoStoreHeaders(
  res: ServerResponse,
  statusCode: number,
  contentType: string,
  extra: Record<string, string> = {}
): void {
  res.writeHead(statusCode, {
    "Cache-Control": "no-store, max-age=0",
    "Pragma": "no-cache",
    "Content-Type": contentType,
    ...extra
  });
}
