import http from "node:http";
import https from "node:https";

type TransferMethod = "GET" | "PUT";

type TransferOptions = {
  method: TransferMethod;
  headers?: Record<string, string>;
  body?: Buffer;
  timeoutMs?: number;
  maxRedirects?: number;
};

type TransferResult = {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  buffer: Buffer;
  finalUrl: string;
};

function transportFor(url: URL) {
  if (url.protocol === "http:") {
    return http;
  }
  if (url.protocol === "https:") {
    return https;
  }
  throw new Error(`Unsupported URL protocol: ${url.protocol}`);
}

function shouldRedirect(statusCode: number, location: string | undefined): boolean {
  return Boolean(location) && [301, 302, 303, 307, 308].includes(statusCode);
}

async function requestBuffer(urlValue: string, options: TransferOptions): Promise<TransferResult> {
  const url = new URL(urlValue);
  const transport = transportFor(url);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxRedirects = options.maxRedirects ?? 4;

  return await new Promise<TransferResult>((resolve, reject) => {
    const req = transport.request(url, {
      method: options.method,
      headers: {
        "user-agent": "simple-fal-mcp/0.1",
        accept: "*/*",
        ...options.headers
      }
    }, response => {
      const statusCode = response.statusCode ?? 0;
      const location = typeof response.headers.location === "string"
        ? response.headers.location
        : undefined;

      if (shouldRedirect(statusCode, location)) {
        if (maxRedirects <= 0) {
          response.resume();
          reject(new Error(`Too many redirects while requesting ${urlValue}`));
          return;
        }
        const nextUrl = new URL(location ?? "", url).toString();
        response.resume();
        void requestBuffer(nextUrl, {
          ...options,
          maxRedirects: maxRedirects - 1
        }).then(resolve, reject);
        return;
      }

      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer | string | Uint8Array) => {
        if (Buffer.isBuffer(chunk)) {
          chunks.push(chunk);
          return;
        }
        if (typeof chunk === "string") {
          chunks.push(Buffer.from(chunk));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      response.on("end", () => {
        const buffer = Buffer.concat(chunks);
        if (statusCode < 200 || statusCode >= 300) {
          reject(new Error(`HTTP ${statusCode} while requesting ${urlValue}`));
          return;
        }
        resolve({
          statusCode,
          headers: response.headers,
          buffer,
          finalUrl: url.toString()
        });
      });
      response.on("error", reject);
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Timed out after ${timeoutMs}ms while requesting ${urlValue}`));
    });
    req.on("error", reject);

    if (options.body) {
      req.write(new Uint8Array(options.body.buffer, options.body.byteOffset, options.body.byteLength));
    }
    req.end();
  });
}

export async function downloadUrlToBuffer(url: string): Promise<{
  buffer: Buffer;
  contentType?: string;
  finalUrl: string;
}> {
  const response = await requestBuffer(url, {
    method: "GET"
  });
  return {
    buffer: response.buffer,
    contentType: typeof response.headers["content-type"] === "string"
      ? response.headers["content-type"]
      : undefined,
    finalUrl: response.finalUrl
  };
}

export async function uploadBufferToUrl(
  url: string,
  buffer: Buffer,
  contentType: string
): Promise<void> {
  await requestBuffer(url, {
    method: "PUT",
    body: buffer,
    headers: {
      "content-type": contentType,
      "content-length": String(buffer.byteLength)
    }
  });
}
