import { z } from "zod";

import {
  getFalAdminApiKeySource,
  getFalApiKeySource,
  getFalCapabilities
} from "../../runtime.js";
import { okResponse, type FalToolContext } from "../shared.js";

const setupWebActionSchema = z.object({
  action: z.enum(["status", "start", "stop"])
});

function buildSetupWebStatusPayload(context: FalToolContext): Record<string, unknown> {
  const setupWeb = context.getSetupWeb();
  const runtime = context.getRuntime();
  const auth = context.getAuth();
  return {
    ok: true,
    running: Boolean(setupWeb),
    url: setupWeb?.state.url ?? null,
    host: setupWeb?.state.host ?? null,
    port: setupWeb?.state.port ?? null,
    keySource: getFalApiKeySource(auth),
    adminKeySource: getFalAdminApiKeySource(auth),
    capabilities: getFalCapabilities(auth),
    workspaceRoot: runtime.workspace.rootDir,
    defaults: runtime.defaults
  };
}

async function handleSetupWebAction(
  context: FalToolContext,
  action: "status" | "start" | "stop"
): Promise<ReturnType<typeof okResponse>> {
  if (action === "status") {
    await context.reloadRuntime("fal_setup_web");
    return okResponse(buildSetupWebStatusPayload(context));
  }

  if (action === "start") {
    const setupWeb = await context.startSetupWebIfNeeded();
    return okResponse({
      ok: true,
      running: true,
      url: setupWeb.state.url,
      host: setupWeb.state.host,
      port: setupWeb.state.port
    });
  }

  const stopped = await context.stopSetupWebIfRunning();
  return okResponse({
    ok: true,
    stopped
  });
}

export function registerFalSetupWebTools(context: FalToolContext): void {
  context.server.registerTool(
    "fal_setup_web",
    {
      title: "fal setup web control",
      description: "Use the local setup panel on demand. action=status checks it, action=start opens it, and action=stop closes it.",
      inputSchema: setupWebActionSchema
    },
    async input => handleSetupWebAction(context, input.action)
  );
}
