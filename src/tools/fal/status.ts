import { z } from "zod";

import { getMediaCapabilities } from "../../media/status.js";
import {
  getFalAdminApiKey,
  getFalAdminApiKeySource,
  getFalApiKey,
  getFalApiKeySource,
  getFalCapabilities,
  isFalConfigured
} from "../../runtime.js";
import { okResponse, type FalToolContext } from "../shared.js";

function statusHint(context: FalToolContext): string {
  const auth = context.getAuth();
  const setupWeb = context.getSetupWeb();
  if (!isFalConfigured(auth) && !setupWeb) {
    return "fal key is missing. Call fal_setup_web with action=start to open the local setup UI.";
  }
  if (!isFalConfigured(auth) && setupWeb) {
    return `fal key is missing. Open ${setupWeb.state.url}`;
  }
  const capabilities = getFalCapabilities(auth);
  if (capabilities.usageAvailable) {
    return "Setup looks ready. Model discovery, usage-based cost analysis, execution, media postprocess, request inspection, and workspace tools can be used.";
  }
  return "Setup looks ready. Model discovery, estimated cost analysis, execution, media postprocess, request inspection, and workspace tools can be used. Add an admin key to unlock usage-based cost reporting.";
}

export function registerFalStatusTool(context: FalToolContext): void {
  context.server.registerTool(
    "fal_status",
    {
      title: "fal MCP status",
      description: "Read runtime status for fal MCP, including API key state, setup-web state, workspace root, saved cursors, and workspace summary.",
      inputSchema: z.object({})
    },
    async () => {
      await context.reloadRuntime("fal_status");
      const auth = context.getAuth();
      const setupWeb = context.getSetupWeb();
      const state = context.getPersistedState();
      const runtime = context.getRuntime();
      const media = await getMediaCapabilities();
      const capabilities = getFalCapabilities(auth);

      return okResponse({
        ok: true,
        version: context.version,
        configPath: context.getConfigPath(),
        authPath: context.getAuthPath(),
        statePath: context.getStatePath(),
        falConfigured: isFalConfigured(auth),
        auth: {
          apiKeyPresent: Boolean(getFalApiKey(auth)),
          source: getFalApiKeySource(auth),
          adminApiKeyPresent: Boolean(getFalAdminApiKey(auth)),
          adminSource: getFalAdminApiKeySource(auth)
        },
        capabilities,
        workspace: runtime.workspace,
        defaults: runtime.defaults,
        misc: runtime.misc,
        media,
        models: {
          lastSession: state.models?.lastSession
            ? {
              savedAt: state.models.lastSession.savedAt,
              query: state.models.lastSession.query ?? null,
              category: state.models.lastSession.category ?? null,
              count: state.models.lastSession.items.length,
              hasMore: state.models.lastSession.hasMore,
              nextCursor: state.models.lastSession.nextCursor ?? null
            }
            : null
        },
        requests: {
          lastHistory: state.requests?.lastHistory
            ? {
              savedAt: state.requests.lastHistory.savedAt,
              endpointId: state.requests.lastHistory.endpointId,
              count: state.requests.lastHistory.items.length,
              hasMore: state.requests.lastHistory.hasMore,
              nextCursor: state.requests.lastHistory.nextCursor ?? null
            }
            : null
        },
        costs: {
          lastUsage: state.costs?.lastUsage
            ? {
                savedAt: state.costs.lastUsage.savedAt,
                endpointIds: state.costs.lastUsage.endpointIds ?? null,
                count: state.costs.lastUsage.items.length,
                hasMore: state.costs.lastUsage.hasMore,
                nextCursor: state.costs.lastUsage.nextCursor ?? null
              }
            : null
        },
        workspaces: {
          count: state.workspaces?.items.length ?? 0,
          lastWorkspaceId: state.workspaces?.lastWorkspaceId ?? null,
          lastRunId: state.workspaces?.lastRunId ?? null
        },
        setupWeb: {
          running: Boolean(setupWeb),
          url: setupWeb?.state.url ?? null,
          host: setupWeb?.state.host ?? null,
          port: setupWeb?.state.port ?? null,
          error: context.getSetupWebError()
        },
        hint: statusHint(context)
      });
    }
  );
}
