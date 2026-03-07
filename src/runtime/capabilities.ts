import type { FalAuthState, RuntimeConfig } from "./types.js";

export function getFalApiKey(auth: FalAuthState): string | undefined {
  return auth.apiKey?.trim() ? auth.apiKey.trim() : undefined;
}

export function getFalAdminApiKey(auth: FalAuthState): string | undefined {
  return auth.adminApiKey?.trim() ? auth.adminApiKey.trim() : undefined;
}

export function getFalApiKeySource(auth: FalAuthState): string | null {
  return auth.source ?? null;
}

export function getFalAdminApiKeySource(auth: FalAuthState): string | null {
  return auth.adminSource ?? null;
}

export function isFalConfigured(auth: FalAuthState): boolean {
  return Boolean(getFalApiKey(auth));
}

export function hasFalAdminAccess(auth: FalAuthState): boolean {
  return Boolean(getFalAdminApiKey(auth));
}

export function getFalCapabilities(auth: FalAuthState): {
  usageAvailable: boolean;
  requestCostConfidence: "usage_window" | "estimated";
} {
  const usageAvailable = hasFalAdminAccess(auth);
  return {
    usageAvailable,
    requestCostConfidence: usageAvailable ? "usage_window" : "estimated"
  };
}

export function getMissingConfigFields(auth: FalAuthState): string[] {
  return getFalApiKey(auth) ? [] : ["fal.apiKey"];
}

export function getWorkspaceRoot(runtime: RuntimeConfig): string {
  return runtime.workspace.rootDir;
}
