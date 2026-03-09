import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";

import type { PersistedState, RunRecord, RuntimeConfig, WorkspaceIndexEntry } from "../runtime.js";
import { readJsonFile, removePath, writeJsonFile } from "../runtime/files.js";

type WorkspaceManifest = {
  workspaceId: string;
  label?: string;
  createdAt: string;
  updatedAt: string;
};

const WORKSPACE_MANIFEST = "workspace.json";
const RUN_MANIFEST = "run.json";

function normalizeWorkspaceId(value: string | undefined): string {
  const source = value?.trim() || `ws-${randomUUID().slice(0, 8)}`;
  return source
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || `ws-${randomUUID().slice(0, 8)}`;
}

export function createRunId(): string {
  return `run-${randomUUID().slice(0, 12)}`;
}

export function getWorkspacePath(runtime: RuntimeConfig, workspaceId: string): string {
  return path.join(runtime.workspace.rootDir, workspaceId);
}

function workspaceManifestPath(runtime: RuntimeConfig, workspaceId: string): string {
  return path.join(getWorkspacePath(runtime, workspaceId), WORKSPACE_MANIFEST);
}

function runsDir(runtime: RuntimeConfig, workspaceId: string): string {
  return path.join(getWorkspacePath(runtime, workspaceId), "runs");
}

function runDir(runtime: RuntimeConfig, workspaceId: string, runId: string): string {
  return path.join(runsDir(runtime, workspaceId), runId);
}

export function runManifestPath(runtime: RuntimeConfig, workspaceId: string, runId: string): string {
  return path.join(runDir(runtime, workspaceId, runId), RUN_MANIFEST);
}

function pruneMissingEntries(runtime: RuntimeConfig, state: PersistedState): PersistedState {
  const items = (state.workspaces?.items ?? []).filter(entry => existsSync(entry.path || getWorkspacePath(runtime, entry.workspaceId)));
  return {
    ...state,
    workspaces: {
      items,
      lastWorkspaceId: state.workspaces?.lastWorkspaceId,
      lastRunId: state.workspaces?.lastRunId
    }
  };
}

export async function ensureWorkspace(
  runtime: RuntimeConfig,
  state: PersistedState,
  requestedId?: string,
  label?: string
): Promise<{ entry: WorkspaceIndexEntry; state: PersistedState }> {
  const workspaceId = normalizeWorkspaceId(requestedId);
  const nextState = pruneMissingEntries(runtime, state);
  const existing = nextState.workspaces?.items.find(item => item.workspaceId === workspaceId);
  const workspacePath = getWorkspacePath(runtime, workspaceId);

  await mkdir(workspacePath, { recursive: true });
  await mkdir(runsDir(runtime, workspaceId), { recursive: true });

  const now = new Date().toISOString();
  const entry: WorkspaceIndexEntry = existing ?? {
    workspaceId,
    label,
    createdAt: now,
    updatedAt: now,
    path: workspacePath,
    runCount: 0
  };
  entry.updatedAt = now;
  entry.path = workspacePath;
  if (label) {
    entry.label = label;
  }

  const manifest: WorkspaceManifest = {
    workspaceId,
    label: entry.label,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt
  };
  await writeJsonFile(workspaceManifestPath(runtime, workspaceId), manifest);

  const items = (nextState.workspaces?.items ?? []).filter(item => item.workspaceId !== workspaceId);
  items.push(entry);
  items.sort((a, b) => a.workspaceId.localeCompare(b.workspaceId));

  return {
    entry,
    state: {
      ...nextState,
      workspaces: {
        items,
        lastWorkspaceId: workspaceId,
        lastRunId: nextState.workspaces?.lastRunId
      }
    }
  };
}

export async function saveRunRecord(
  runtime: RuntimeConfig,
  state: PersistedState,
  record: RunRecord
): Promise<PersistedState> {
  await mkdir(runDir(runtime, record.workspaceId, record.runId), { recursive: true });
  await writeJsonFile(runManifestPath(runtime, record.workspaceId, record.runId), record);

  const nextState = pruneMissingEntries(runtime, state);
  const items = [...(nextState.workspaces?.items ?? [])];
  const index = items.findIndex(item => item.workspaceId === record.workspaceId);
  const now = new Date().toISOString();
  if (index >= 0) {
    const existing = items[index]!;
    items[index] = {
      ...existing,
      updatedAt: now,
      runCount: Math.max(existing.runCount, 0) + (existing.lastRunId === record.runId ? 0 : 1),
      lastRunId: record.runId
    };
  } else {
    items.push({
      workspaceId: record.workspaceId,
      createdAt: now,
      updatedAt: now,
      path: getWorkspacePath(runtime, record.workspaceId),
      runCount: 1,
      lastRunId: record.runId
    });
  }

  return {
    ...nextState,
    workspaces: {
      items,
      lastWorkspaceId: record.workspaceId,
      lastRunId: record.runId
    }
  };
}

export async function loadRunRecord(
  runtime: RuntimeConfig,
  workspaceId: string,
  runId: string
): Promise<RunRecord | null> {
  const filePath = runManifestPath(runtime, workspaceId, runId);
  if (!existsSync(filePath)) {
    return null;
  }
  return readJsonFile<RunRecord>(filePath);
}

export async function listWorkspaceRuns(runtime: RuntimeConfig, workspaceId: string): Promise<RunRecord[]> {
  const directory = runsDir(runtime, workspaceId);
  if (!existsSync(directory)) {
    return [];
  }
  const entries = await readdir(directory, { withFileTypes: true });
  const runs: RunRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const run = await loadRunRecord(runtime, workspaceId, entry.name);
    if (run) {
      runs.push(run);
    }
  }
  runs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return runs;
}

export async function getWorkspaceDetails(runtime: RuntimeConfig, state: PersistedState, workspaceId: string): Promise<Record<string, unknown> | null> {
  const entry = state.workspaces?.items.find(item => item.workspaceId === workspaceId);
  const manifestPath = workspaceManifestPath(runtime, workspaceId);
  if (!entry && !existsSync(manifestPath)) {
    return null;
  }
  const manifest = existsSync(manifestPath)
    ? await readJsonFile<WorkspaceManifest>(manifestPath)
    : undefined;
  const runs = await listWorkspaceRuns(runtime, workspaceId);
  return {
    workspaceId,
    path: getWorkspacePath(runtime, workspaceId),
    label: entry?.label ?? manifest?.label ?? null,
    createdAt: entry?.createdAt ?? manifest?.createdAt ?? null,
    updatedAt: entry?.updatedAt ?? manifest?.updatedAt ?? null,
    runCount: runs.length,
    runs: runs.map(run => ({
      runId: run.runId,
      endpointId: run.endpointId,
      requestId: run.requestId ?? null,
      mode: run.mode,
      status: run.status,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      uploads: run.uploads ?? [],
      artifacts: run.artifacts,
      artifactIssues: run.artifactIssues ?? [],
      cost: run.cost ?? null,
      error: run.error ?? null,
      providerFailure: run.providerFailure ?? null
    }))
  };
}

export async function deleteWorkspace(runtime: RuntimeConfig, state: PersistedState, workspaceId: string): Promise<PersistedState> {
  await removePath(getWorkspacePath(runtime, workspaceId));
  const items = (state.workspaces?.items ?? []).filter(item => item.workspaceId !== workspaceId);
  return {
    ...state,
    workspaces: {
      items,
      lastWorkspaceId: state.workspaces?.lastWorkspaceId === workspaceId ? undefined : state.workspaces?.lastWorkspaceId,
      lastRunId: state.workspaces?.lastRunId
    }
  };
}

export async function cleanupWorkspaces(
  runtime: RuntimeConfig,
  state: PersistedState,
  olderThanHours: number
): Promise<{ state: PersistedState; deleted: string[] }> {
  const now = Date.now();
  const maxAgeMs = Math.max(0, olderThanHours) * 60 * 60 * 1000;
  const keep: WorkspaceIndexEntry[] = [];
  const deleted: string[] = [];

  for (const entry of state.workspaces?.items ?? []) {
    const updatedAtMs = Date.parse(entry.updatedAt);
    const stale = Number.isFinite(updatedAtMs) && maxAgeMs > 0 && updatedAtMs < now - maxAgeMs;
    const missing = !existsSync(entry.path);
    if (stale || missing) {
      await removePath(entry.path);
      deleted.push(entry.workspaceId);
      continue;
    }
    keep.push(entry);
  }

  return {
    state: {
      ...state,
      workspaces: {
        items: keep,
        lastWorkspaceId: deleted.includes(state.workspaces?.lastWorkspaceId ?? "") ? undefined : state.workspaces?.lastWorkspaceId,
        lastRunId: state.workspaces?.lastRunId
      }
    },
    deleted
  };
}

export async function findRunRecord(runtime: RuntimeConfig, state: PersistedState, runId: string): Promise<RunRecord | null> {
  for (const entry of state.workspaces?.items ?? []) {
    const run = await loadRunRecord(runtime, entry.workspaceId, runId);
    if (run) {
      return run;
    }
  }
  return null;
}
