import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import {
  DEFAULT_ARTIFACT_DOWNLOAD_LIMIT,
  DEFAULT_MODEL_SEARCH_LIMIT,
  DEFAULT_OBJECT_TTL_SECONDS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_WAIT_MS
} from "../fal/constants.js";
import { getBoolean, getNumber, getString, parseArgs } from "./args.js";
import { readJsonFile, removePath, writeJsonFile } from "./files.js";
import { defaultStatePath, loadPersistedState } from "./state.js";
import type { CliArgs, FalAuthState, FileAuthConfig, FileConfig, RuntimeConfig, RuntimeState } from "./types.js";

function envString(name: string): string | undefined {
  return getString(process.env[name]);
}

function envNumber(name: string): number | undefined {
  return getNumber(process.env[name]);
}

function envBoolean(name: string): boolean | undefined {
  return getBoolean(process.env[name]);
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.trunc(value));
}

function normalizePositiveInteger(value: number | undefined, fallback: number, min = 1): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.trunc(value));
}

export function defaultConfigPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && xdg.trim() !== "") {
    return path.join(xdg, "simple-fal-mcp", "config.json");
  }
  return path.join(os.homedir(), ".config", "simple-fal-mcp", "config.json");
}

export function defaultAuthPath(configPath: string): string {
  return path.join(path.dirname(configPath), "auth.json");
}

export function defaultWorkspaceRoot(): string {
  return path.join(os.tmpdir(), "simple-fal-mcp", "workspaces");
}

export async function loadConfig(configPath: string, explicit: boolean): Promise<FileConfig> {
  if (!existsSync(configPath)) {
    if (explicit) {
      console.error(`[simple-fal-mcp] config not found: ${configPath}`);
    }
    return {};
  }
  try {
    return (await readJsonFile<FileConfig>(configPath)) ?? {};
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`[simple-fal-mcp] failed to parse config ${configPath}: ${message}`);
  }
}

export async function loadAuthConfig(authPath: string, explicit: boolean): Promise<FileAuthConfig> {
  if (!existsSync(authPath)) {
    if (explicit) {
      console.error(`[simple-fal-mcp] auth file not found: ${authPath}`);
    }
    return {};
  }
  try {
    return (await readJsonFile<FileAuthConfig>(authPath)) ?? {};
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`[simple-fal-mcp] failed to parse auth ${authPath}: ${message}`);
  }
}

export function buildRuntimeConfig(args: CliArgs, fileConfig: FileConfig): RuntimeConfig {
  const waitMs = getNumber(args["default-wait-ms"]) ??
    envNumber("FAL_DEFAULT_WAIT_MS") ??
    fileConfig.defaults?.waitMs ??
    DEFAULT_WAIT_MS;
  const pollIntervalMs = getNumber(args["poll-interval-ms"]) ??
    envNumber("FAL_POLL_INTERVAL_MS") ??
    fileConfig.defaults?.pollIntervalMs ??
    DEFAULT_POLL_INTERVAL_MS;
  const modelSearchLimit = getNumber(args["model-search-limit"]) ??
    envNumber("FAL_MODEL_SEARCH_LIMIT") ??
    fileConfig.defaults?.modelSearchLimit ??
    DEFAULT_MODEL_SEARCH_LIMIT;
  const artifactDownloadLimit = getNumber(args["artifact-download-limit"]) ??
    envNumber("FAL_ARTIFACT_DOWNLOAD_LIMIT") ??
    fileConfig.defaults?.artifactDownloadLimit ??
    DEFAULT_ARTIFACT_DOWNLOAD_LIMIT;
  const objectTtlSeconds = getNumber(args["object-ttl-seconds"]) ??
    envNumber("FAL_OBJECT_TTL_SECONDS") ??
    fileConfig.defaults?.objectTtlSeconds ??
    DEFAULT_OBJECT_TTL_SECONDS;
  const downloadOutputs = getBoolean(args["download-outputs"]) ??
    envBoolean("FAL_DOWNLOAD_OUTPUTS") ??
    fileConfig.defaults?.downloadOutputs ??
    true;
  const workspaceRoot = getString(args["workspace-root"]) ??
    envString("FAL_WORKSPACE_ROOT") ??
    fileConfig.workspace?.rootDir ??
    defaultWorkspaceRoot();
  const workspaceAutoCleanupHours = getNumber(args["workspace-auto-cleanup-hours"]) ??
    envNumber("FAL_WORKSPACE_AUTO_CLEANUP_HOURS") ??
    fileConfig.workspace?.autoCleanupHours ??
    48;
  const setupWebAutoStopMinutes = getNumber(args["setup-web-auto-stop-minutes"]) ??
    envNumber("FAL_SETUP_WEB_AUTO_STOP_MINUTES") ??
    fileConfig.misc?.setupWebAutoStopMinutes ??
    0;

  return {
    defaults: {
      waitMs: normalizePositiveInteger(waitMs, DEFAULT_WAIT_MS),
      pollIntervalMs: normalizePositiveInteger(pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, 100),
      modelSearchLimit: normalizePositiveInteger(modelSearchLimit, DEFAULT_MODEL_SEARCH_LIMIT),
      artifactDownloadLimit: normalizePositiveInteger(artifactDownloadLimit, DEFAULT_ARTIFACT_DOWNLOAD_LIMIT),
      objectTtlSeconds: normalizePositiveInteger(objectTtlSeconds, DEFAULT_OBJECT_TTL_SECONDS),
      downloadOutputs
    },
    workspace: {
      rootDir: workspaceRoot,
      autoCleanupHours: normalizeNonNegativeInteger(workspaceAutoCleanupHours, 48)
    },
    misc: {
      setupWebAutoStopMinutes: normalizeNonNegativeInteger(setupWebAutoStopMinutes, 0)
    }
  };
}

export function buildAuthState(args: CliArgs, fileAuth: FileAuthConfig): FalAuthState {
  const argKey = getString(args["fal-key"]);
  const envKey = envString("FAL_KEY");
  const fileKey = fileAuth.fal?.apiKey?.trim();

  const argAdminKey = getString(args["fal-admin-key"]);
  const envAdminKey = envString("FAL_ADMIN_KEY");
  const fileAdminKey = fileAuth.fal?.adminApiKey?.trim();

  const auth: FalAuthState = {};
  if (argKey) {
    auth.apiKey = argKey;
    auth.source = "args";
  } else if (envKey) {
    auth.apiKey = envKey;
    auth.source = "env";
  } else if (fileKey) {
    auth.apiKey = fileKey;
    auth.source = "file";
  }

  if (argAdminKey) {
    auth.adminApiKey = argAdminKey;
    auth.adminSource = "args";
  } else if (envAdminKey) {
    auth.adminApiKey = envAdminKey;
    auth.adminSource = "env";
  } else if (fileAdminKey) {
    auth.adminApiKey = fileAdminKey;
    auth.adminSource = "file";
  }

  return auth;
}

export async function loadRuntime(argv: string[]): Promise<RuntimeState> {
  const args = parseArgs(argv);
  const configArgProvided = argv.some(arg => arg === "--config" || arg.startsWith("--config="));
  const configPath = getString(args.config) ?? defaultConfigPath();
  const authArgProvided = argv.some(arg => arg === "--auth" || arg.startsWith("--auth="));
  const authPath = getString(args.auth) ?? defaultAuthPath(configPath);
  const stateArgProvided = argv.some(arg => arg === "--state" || arg.startsWith("--state="));
  const statePath = getString(args.state) ?? defaultStatePath(configPath);

  const [fileConfig, fileAuth, state] = await Promise.all([
    loadConfig(configPath, configArgProvided),
    loadAuthConfig(authPath, authArgProvided),
    loadPersistedState(statePath, stateArgProvided)
  ]);

  return {
    args,
    runtime: buildRuntimeConfig(args, fileConfig),
    auth: buildAuthState(args, fileAuth),
    state,
    configPath,
    authPath,
    statePath,
    configArgProvided,
    authArgProvided,
    stateArgProvided
  };
}

export async function saveRuntimeConfig(configPath: string, runtime: RuntimeConfig): Promise<void> {
  const fileConfig: FileConfig = {
    defaults: {
      waitMs: runtime.defaults.waitMs,
      pollIntervalMs: runtime.defaults.pollIntervalMs,
      modelSearchLimit: runtime.defaults.modelSearchLimit,
      artifactDownloadLimit: runtime.defaults.artifactDownloadLimit,
      objectTtlSeconds: runtime.defaults.objectTtlSeconds,
      downloadOutputs: runtime.defaults.downloadOutputs
    },
    workspace: {
      rootDir: runtime.workspace.rootDir,
      autoCleanupHours: runtime.workspace.autoCleanupHours
    },
    misc: {
      setupWebAutoStopMinutes: runtime.misc.setupWebAutoStopMinutes
    }
  };
  await writeJsonFile(configPath, fileConfig);
}

export async function saveAuthState(authPath: string, auth: FalAuthState): Promise<void> {
  const fileAuth: FileAuthConfig = {
    fal: auth.apiKey || auth.adminApiKey
      ? {
          apiKey: auth.apiKey,
          adminApiKey: auth.adminApiKey
        }
      : undefined
  };
  await writeJsonFile(authPath, fileAuth);
}

export async function clearAuthState(authPath: string): Promise<void> {
  if (existsSync(authPath)) {
    await removePath(authPath);
  }
}
