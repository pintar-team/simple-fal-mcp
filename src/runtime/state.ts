import { existsSync } from "node:fs";
import path from "node:path";

import type { PersistedState } from "./types.js";
import { readJsonFile, writeJsonFile } from "./files.js";

export function defaultStatePath(configPath: string): string {
  return path.join(path.dirname(configPath), "state.json");
}

function normalizeState(value: PersistedState | undefined): PersistedState {
  return {
    models: value?.models,
    requests: value?.requests,
    costs: value?.costs,
    workspaces: {
      items: value?.workspaces?.items ?? [],
      lastWorkspaceId: value?.workspaces?.lastWorkspaceId,
      lastRunId: value?.workspaces?.lastRunId
    }
  };
}

export async function loadPersistedState(statePath: string, explicit: boolean): Promise<PersistedState> {
  if (!existsSync(statePath)) {
    if (explicit) {
      console.error(`[simple-fal-mcp] state file not found: ${statePath}`);
    }
    return normalizeState(undefined);
  }
  try {
    const parsed = await readJsonFile<PersistedState>(statePath);
    return normalizeState(parsed);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`[simple-fal-mcp] failed to parse state ${statePath}: ${message}`);
  }
}

export async function savePersistedState(statePath: string, nextState: PersistedState): Promise<void> {
  await writeJsonFile(statePath, normalizeState(nextState));
}
