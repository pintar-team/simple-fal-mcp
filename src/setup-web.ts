import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import {
  getFalAdminApiKey,
  getFalAdminApiKeySource,
  getFalApiKey,
  getFalApiKeySource,
  getFalCapabilities,
  getMissingConfigFields
} from "./runtime/capabilities.js";
import { mergeRuntimeConfig } from "./setup-web/config-merge.js";
import {
  getHeaderSetupToken,
  getQuerySetupToken,
  isValidSetupToken,
  parseJsonBody,
  readRequestBody,
  SetupWebRequestError,
  writeNoStoreHeaders
} from "./setup-web/http.js";
import { listenOnPort, normalizeHost, parsePort } from "./setup-web/net.js";
import { buildSetupPage } from "./setup-web/page.js";
import type { SetupWebController, SetupWebHandlers, SetupWebOptions } from "./setup-web/types.js";

function buildApiStatus(
  configPath: string,
  authPath: string,
  statePath: string,
  runtime: SetupWebHandlers["getRuntime"] extends () => infer T ? T : never,
  auth: SetupWebHandlers["getAuth"] extends () => infer T ? T : never,
  persistedState: SetupWebHandlers["getPersistedState"] extends () => infer T ? T : never
): Record<string, unknown> {
  const apiKey = getFalApiKey(auth);
  const adminApiKey = getFalAdminApiKey(auth);
  const capabilities = getFalCapabilities(auth);
  const lastModelSearch = persistedState.models?.lastSession;
  const lastRequestHistory = persistedState.requests?.lastHistory;
  const lastUsage = persistedState.costs?.lastUsage;
  return {
    ok: true,
    configPath,
    authPath,
    statePath,
    missingConfig: getMissingConfigFields(auth),
    auth: {
      apiKeyPresent: Boolean(apiKey),
      source: getFalApiKeySource(auth),
      adminApiKeyPresent: Boolean(adminApiKey),
      adminSource: getFalAdminApiKeySource(auth)
    },
    capabilities,
    defaults: runtime.defaults,
    workspace: runtime.workspace,
    misc: runtime.misc,
    state: {
      workspaceCount: persistedState.workspaces?.items.length ?? 0,
      lastWorkspaceId: persistedState.workspaces?.lastWorkspaceId ?? null,
      lastRunId: persistedState.workspaces?.lastRunId ?? null,
      lastModelSearch: lastModelSearch
        ? {
          query: lastModelSearch.query ?? null,
          category: lastModelSearch.category ?? null,
          count: lastModelSearch.items.length,
          hasMore: lastModelSearch.hasMore,
          nextCursor: lastModelSearch.nextCursor ?? null
        }
        : null,
      lastRequestHistory: lastRequestHistory
        ? {
          endpointId: lastRequestHistory.endpointId,
          count: lastRequestHistory.items.length,
          hasMore: lastRequestHistory.hasMore,
          nextCursor: lastRequestHistory.nextCursor ?? null
        }
        : null,
      lastUsage: lastUsage
        ? {
          endpointIds: lastUsage.endpointIds ?? null,
          count: lastUsage.items.length,
          hasMore: lastUsage.hasMore,
          nextCursor: lastUsage.nextCursor ?? null
        }
        : null
    },
    hint: apiKey
      ? (capabilities.usageAvailable
        ? "fal looks ready. Usage-based cost analysis is enabled."
        : "fal looks ready. Add an optional admin key if you want usage-based cost analysis.")
      : "Add the fal API key and save config before running models."
  };
}

export async function startSetupWebServer(
  options: SetupWebOptions,
  handlers: SetupWebHandlers
): Promise<SetupWebController> {
  const host = normalizeHost(options.host);
  const requestedPort = parsePort(options.port);
  const token = options.token?.trim() || randomBytes(16).toString("hex");

  const server = createServer((req, res) => {
    void handleRequest(req, res).catch(err => {
      const message = err instanceof Error ? err.message : String(err);
      try {
        if (!res.headersSent) {
          writeNoStoreHeaders(res, 500, "application/json");
        }
        if (!res.writableEnded) {
          res.end(JSON.stringify({ ok: false, error: message }));
        }
      } catch {
        // ignore socket write failures
      }
    });
  });

  let port = requestedPort;
  let baseUrl = `http://${host}:${requestedPort}/`;

  const ensureToken = (req: IncomingMessage, url: URL): void => {
    const submitted = getHeaderSetupToken(req) ?? getQuerySetupToken(url);
    if (!isValidSetupToken(submitted, token)) {
      throw new SetupWebRequestError(401, "Invalid setup token");
    }
  };

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (!req.url || !req.method) {
        writeNoStoreHeaders(res, 400, "application/json");
        res.end(JSON.stringify({ ok: false, error: "Invalid request" }));
        return;
      }

      const url = new URL(req.url, baseUrl);
      if (handlers.reloadState) {
        await handlers.reloadState();
      }

      const runtime = handlers.getRuntime();
      const auth = handlers.getAuth();
      const persistedState = handlers.getPersistedState();

      if (req.method === "GET" && url.pathname === "/") {
        ensureToken(req, url);
        const html = buildSetupPage(
          options.configPath,
          options.authPath,
          options.statePath,
          token,
          runtime,
          auth,
          persistedState
        );
        writeNoStoreHeaders(res, 200, "text/html; charset=utf-8", { "Referrer-Policy": "no-referrer" });
        res.end(html);
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/status") {
        ensureToken(req, url);
        writeNoStoreHeaders(res, 200, "application/json");
        res.end(JSON.stringify(buildApiStatus(
          options.configPath,
          options.authPath,
          options.statePath,
          runtime,
          auth,
          persistedState
        )));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/config") {
        ensureToken(req, url);
        const patch = parseJsonBody(await readRequestBody(req));
        const nextRuntime = mergeRuntimeConfig(runtime, patch as never);
        await handlers.saveConfigPatch(patch as never);
        writeNoStoreHeaders(res, 200, "application/json");
        res.end(JSON.stringify({
          ok: true,
          defaults: nextRuntime.defaults,
          workspace: nextRuntime.workspace,
          misc: nextRuntime.misc
        }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/auth/clear") {
        ensureToken(req, url);
        const nextAuth = await handlers.clearAuth();
        writeNoStoreHeaders(res, 200, "application/json");
        res.end(JSON.stringify({
          ok: true,
          apiKeyPresent: Boolean(getFalApiKey(nextAuth)),
          source: getFalApiKeySource(nextAuth),
          adminApiKeyPresent: Boolean(getFalAdminApiKey(nextAuth)),
          adminSource: getFalAdminApiKeySource(nextAuth)
        }));
        return;
      }

      writeNoStoreHeaders(res, 404, "application/json");
      res.end(JSON.stringify({ ok: false, error: "Not found" }));
    } catch (err) {
      const isClientError = err instanceof SetupWebRequestError;
      const statusCode = isClientError ? err.statusCode : 500;
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) {
        writeNoStoreHeaders(res, statusCode, "application/json");
      }
      if (!res.writableEnded) {
        res.end(JSON.stringify({ ok: false, error: message }));
      }
    }
  };

  port = await listenOnPort(server, host, requestedPort);
  baseUrl = `http://${host}:${port}/`;
  const url = `${baseUrl}?token=${encodeURIComponent(token)}`;

  return {
    state: {
      host,
      port,
      url,
      token
    },
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close(err => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      });
    }
  };
}

export type { SetupWebController } from "./setup-web/types.js";
