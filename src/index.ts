#!/usr/bin/env node
import { createRequire } from "node:module";
import process from "node:process";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import {
  clearAuthState,
  loadRuntime,
  saveAuthState,
  savePersistedState as writePersistedState,
  saveRuntimeConfig,
  type FalAuthState,
  type PersistedState,
  type RuntimeConfig
} from "./runtime.js";
import { startSetupWebServer, type SetupWebController } from "./setup-web.js";
import { mergeRuntimeConfig } from "./setup-web/config-merge.js";
import { registerFalModelTool } from "./tools/fal/model.js";
import { registerFalMediaTool } from "./tools/fal/media.js";
import { registerFalCostTool } from "./tools/fal/cost.js";
import { registerFalRequestTool } from "./tools/fal/request.js";
import { registerFalRunTool } from "./tools/fal/run.js";
import { registerFalSetupWebTools } from "./tools/fal/setup-web.js";
import { registerFalStatusTool } from "./tools/fal/status.js";
import { registerFalWorkspaceTool } from "./tools/fal/workspace.js";
import { DEFAULT_SETUP_HOST, DEFAULT_SETUP_PORT } from "./fal/constants.js";

function readVersionFromPackageJson(): string {
  try {
    const localRequire = createRequire(import.meta.url);
    const pkg = localRequire("../package.json") as { version?: unknown };
    if (typeof pkg.version === "string" && pkg.version.trim() !== "") {
      return pkg.version.trim();
    }
  } catch {
    // fallback below
  }
  return "0.0.0";
}

const VERSION = readVersionFromPackageJson();
const SERVER_NAME = "simple_fal";
const SERVER_TITLE = "Simple fal MCP";

const argv = process.argv.slice(2);
const loaded = await loadRuntime(argv);
let runtime: RuntimeConfig = loaded.runtime;
let auth: FalAuthState = loaded.auth;
let persistedState: PersistedState = loaded.state;
const { args, configPath, authPath, statePath } = loaded;

const setupHost = typeof args["setup-host"] === "string" ? args["setup-host"] : DEFAULT_SETUP_HOST;
const setupPortRaw = typeof args["setup-port"] === "string" ? Number(args["setup-port"]) : DEFAULT_SETUP_PORT;
const setupPort = Number.isInteger(setupPortRaw) && setupPortRaw > 0 && setupPortRaw <= 65535
  ? setupPortRaw
  : DEFAULT_SETUP_PORT;
const setupToken = typeof args["setup-token"] === "string" ? args["setup-token"] : undefined;

let setupWeb: SetupWebController | null = null;
let setupWebError: string | null = null;
let setupWebAutoStopTimer: NodeJS.Timeout | null = null;

async function reloadRuntimeFromDisk(context: string): Promise<void> {
  try {
    const latest = await loadRuntime(argv);
    runtime = latest.runtime;
    auth = latest.auth;
    persistedState = latest.state;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[simple-fal-mcp] runtime reload failed (${context}): ${message}`);
  }
}

async function saveConfigPatch(patch: Parameters<typeof mergeRuntimeConfig>[1]): Promise<RuntimeConfig> {
  const nextRuntime = mergeRuntimeConfig(runtime, patch);
  await saveRuntimeConfig(configPath, nextRuntime);
  const nextAuth: FalAuthState = {
    apiKey: auth.apiKey,
    adminApiKey: auth.adminApiKey,
    source: auth.apiKey ? "file" : undefined,
    adminSource: auth.adminApiKey ? "file" : undefined
  };
  let shouldPersistAuth = false;
  if (typeof patch.fal?.apiKey === "string" && patch.fal.apiKey.trim() !== "") {
    nextAuth.apiKey = patch.fal.apiKey.trim();
    nextAuth.source = "file";
    shouldPersistAuth = true;
  }
  if (typeof patch.fal?.adminApiKey === "string" && patch.fal.adminApiKey.trim() !== "") {
    nextAuth.adminApiKey = patch.fal.adminApiKey.trim();
    nextAuth.adminSource = "file";
    shouldPersistAuth = true;
  }
  if (shouldPersistAuth) {
    await saveAuthState(authPath, nextAuth);
  }
  await reloadRuntimeFromDisk("save_config_patch");
  return runtime;
}

async function persistState(nextState: PersistedState, context: string): Promise<PersistedState> {
  await writePersistedState(statePath, nextState);
  await reloadRuntimeFromDisk(context);
  return persistedState;
}

function resetSetupWebAutoStopTimer(): void {
  if (setupWebAutoStopTimer) {
    clearTimeout(setupWebAutoStopTimer);
    setupWebAutoStopTimer = null;
  }
}

function armSetupWebAutoStop(): void {
  resetSetupWebAutoStopTimer();
  if (!setupWeb) {
    return;
  }
  const minutes = runtime.misc.setupWebAutoStopMinutes;
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return;
  }
  setupWebAutoStopTimer = setTimeout(() => {
    void stopSetupWebIfRunning();
  }, minutes * 60 * 1000);
}

async function startSetupWebIfNeeded(): Promise<SetupWebController> {
  if (setupWeb) {
    armSetupWebAutoStop();
    return setupWeb;
  }
  setupWebError = null;
  setupWeb = await startSetupWebServer(
    {
      host: setupHost,
      port: setupPort,
      token: setupToken,
      configPath,
      authPath,
      statePath
    },
    {
      getRuntime: () => runtime,
      getAuth: () => auth,
      getPersistedState: () => persistedState,
      reloadState: async () => {
        await reloadRuntimeFromDisk("setup_web");
      },
      saveConfigPatch,
      clearAuth: async () => {
        await clearAuthState(authPath);
        await reloadRuntimeFromDisk("clear_auth");
        return auth;
      }
    }
  );
  armSetupWebAutoStop();
  console.error(`[simple-fal-mcp] setup web ready at ${setupWeb.state.url} (local only)`);
  return setupWeb;
}

async function stopSetupWebIfRunning(): Promise<boolean> {
  if (!setupWeb) {
    resetSetupWebAutoStopTimer();
    return false;
  }
  const controller = setupWeb;
  setupWeb = null;
  resetSetupWebAutoStopTimer();
  await controller.close();
  return true;
}

const server = new McpServer(
  {
    name: SERVER_NAME,
    title: SERVER_TITLE,
    version: VERSION
  },
  {
    capabilities: { tools: {} }
  }
);

const toolContext = {
  server,
  version: VERSION,
  getRuntime: () => runtime,
  getAuth: () => auth,
  getPersistedState: () => persistedState,
  getConfigPath: () => configPath,
  getAuthPath: () => authPath,
  getStatePath: () => statePath,
  reloadRuntime: reloadRuntimeFromDisk,
  saveConfigPatch,
  savePersistedState: persistState,
  startSetupWebIfNeeded,
  stopSetupWebIfRunning,
  getSetupWeb: () => setupWeb,
  getSetupWebError: () => setupWebError,
  setSetupWebError: (message: string | null) => {
    setupWebError = message;
  }
};

registerFalStatusTool(toolContext);
registerFalSetupWebTools(toolContext);
registerFalModelTool(toolContext);
registerFalCostTool(toolContext);
registerFalRunTool(toolContext);
registerFalRequestTool(toolContext);
registerFalWorkspaceTool(toolContext);
registerFalMediaTool(toolContext);

const transport = new StdioServerTransport();
const parentPidAtLaunch = process.ppid;
let shutdownStarted = false;
let parentWatchdogTimer: NodeJS.Timeout | null = null;

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

const onStdinClosed = (): void => {
  void shutdown("stdin_closed");
};

function startParentWatchdog(): void {
  if (parentPidAtLaunch <= 1) {
    return;
  }
  parentWatchdogTimer = setInterval(() => {
    if (!isProcessAlive(parentPidAtLaunch)) {
      void shutdown("parent_exit");
    }
  }, 2000);
  parentWatchdogTimer.unref();
}

async function shutdown(reason: string): Promise<void> {
  if (shutdownStarted) {
    return;
  }
  shutdownStarted = true;
  resetSetupWebAutoStopTimer();
  if (parentWatchdogTimer) {
    clearInterval(parentWatchdogTimer);
    parentWatchdogTimer = null;
  }
  process.stdin.off("end", onStdinClosed);
  process.stdin.off("close", onStdinClosed);
  try {
    await stopSetupWebIfRunning();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[simple-fal-mcp] setup web shutdown warning (${reason}): ${message}`);
  }
  try {
    await server.close();
  } catch {
    // ignore
  }
}

process.stdin.on("end", onStdinClosed);
process.stdin.on("close", onStdinClosed);
process.on("SIGINT", () => {
  void shutdown("sigint").finally(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void shutdown("sigterm").finally(() => process.exit(0));
});
startParentWatchdog();

await server.connect(transport);
