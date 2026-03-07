import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { PersistedState, RuntimeConfig, FalAuthState } from "../runtime.js";
import type { SetupWebController } from "../setup-web.js";
import type { SetupWebConfigPatch } from "../setup-web/types.js";

export type ToolResponse = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export type FalToolContext = {
  server: McpServer;
  version: string;
  getRuntime: () => RuntimeConfig;
  getAuth: () => FalAuthState;
  getPersistedState: () => PersistedState;
  getConfigPath: () => string;
  getAuthPath: () => string;
  getStatePath: () => string;
  reloadRuntime: (context: string) => Promise<void>;
  saveConfigPatch: (patch: SetupWebConfigPatch) => Promise<RuntimeConfig>;
  savePersistedState: (nextState: PersistedState, context: string) => Promise<PersistedState>;
  startSetupWebIfNeeded: () => Promise<SetupWebController>;
  stopSetupWebIfRunning: () => Promise<boolean>;
  getSetupWeb: () => SetupWebController | null;
  getSetupWebError: () => string | null;
  setSetupWebError: (message: string | null) => void;
};

export function okResponse(payload: Record<string, unknown>): ToolResponse {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }]
  };
}

export function errorResponse(err: unknown): ToolResponse {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text", text: message }],
    isError: true
  };
}
