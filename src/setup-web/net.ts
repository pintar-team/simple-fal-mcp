import type { Server } from "node:http";

import { DEFAULT_SETUP_HOST, DEFAULT_SETUP_PORT } from "../fal/constants.js";

export function normalizeHost(host: string | undefined): string {
  return host?.trim() || DEFAULT_SETUP_HOST;
}

export function parsePort(port: number | string | undefined): number {
  const numeric = typeof port === "string" ? Number(port) : port;
  if (Number.isInteger(numeric) && numeric && numeric > 0 && numeric <= 65_535) {
    return numeric;
  }
  return DEFAULT_SETUP_PORT;
}

export async function listenOnPort(server: Server, host: string, requestedPort: number): Promise<number> {
  const startPort = requestedPort;
  const maxAttempts = 12;
  for (let offset = 0; offset < maxAttempts; offset += 1) {
    const port = startPort + offset;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error & { code?: string }) => {
          server.off("listening", onListening);
          reject(err);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      });
      return port;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EADDRINUSE") {
        throw err;
      }
    }
  }

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, host);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to bind setup web server");
  }
  return address.port;
}
