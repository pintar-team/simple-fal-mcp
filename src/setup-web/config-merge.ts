import type { RuntimeConfig } from "../runtime.js";
import type { SetupWebConfigPatch } from "./types.js";

function normalizeNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return value;
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function mergeRuntimeConfig(runtime: RuntimeConfig, patch: SetupWebConfigPatch): RuntimeConfig {
  const next: RuntimeConfig = structuredClone(runtime);

  if (patch.defaults) {
    const waitMs = normalizeNumber(patch.defaults.waitMs);
    const pollIntervalMs = normalizeNumber(patch.defaults.pollIntervalMs);
    const modelSearchLimit = normalizeNumber(patch.defaults.modelSearchLimit);
    const artifactDownloadLimit = normalizeNumber(patch.defaults.artifactDownloadLimit);
    const objectTtlSeconds = normalizeNumber(patch.defaults.objectTtlSeconds);
    const downloadOutputs = typeof patch.defaults.downloadOutputs === "boolean"
      ? patch.defaults.downloadOutputs
      : undefined;

    if (waitMs !== undefined) next.defaults.waitMs = Math.max(1_000, Math.trunc(waitMs));
    if (pollIntervalMs !== undefined) next.defaults.pollIntervalMs = Math.max(100, Math.trunc(pollIntervalMs));
    if (modelSearchLimit !== undefined) next.defaults.modelSearchLimit = Math.max(1, Math.trunc(modelSearchLimit));
    if (artifactDownloadLimit !== undefined) next.defaults.artifactDownloadLimit = Math.max(1, Math.trunc(artifactDownloadLimit));
    if (objectTtlSeconds !== undefined) next.defaults.objectTtlSeconds = Math.max(60, Math.trunc(objectTtlSeconds));
    if (downloadOutputs !== undefined) next.defaults.downloadOutputs = downloadOutputs;
  }

  if (patch.workspace) {
    const rootDir = normalizeString(patch.workspace.rootDir);
    const autoCleanupHours = normalizeNumber(patch.workspace.autoCleanupHours);
    if (rootDir !== undefined) next.workspace.rootDir = rootDir;
    if (autoCleanupHours !== undefined) next.workspace.autoCleanupHours = Math.max(0, Math.trunc(autoCleanupHours));
  }

  if (patch.misc) {
    const setupWebAutoStopMinutes = normalizeNumber(patch.misc.setupWebAutoStopMinutes);
    if (setupWebAutoStopMinutes !== undefined) {
      next.misc.setupWebAutoStopMinutes = Math.max(0, Math.trunc(setupWebAutoStopMinutes));
    }
  }

  return next;
}
