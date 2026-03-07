import type { ArtifactIssue, RunRecord } from "../runtime.js";

type ErrorLike = {
  name?: string;
  message?: string;
  cause?: unknown;
};

export function formatErrorWithCauses(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current && !seen.has(current)) {
    seen.add(current);
    const candidate = current as ErrorLike;
    const name = candidate.name?.trim();
    const message = candidate.message?.trim();
    if (name && message) {
      parts.push(`${name}: ${message}`);
    } else if (message) {
      parts.push(message);
    } else {
      parts.push("[unknown error]");
    }
    current = candidate.cause;
  }

  return parts.join(" <- ");
}

function looksLikeStorageTimeout(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("connect timeout") ||
    normalized.includes("timed out") ||
    normalized.includes("fetch failed")
  ) && (
    normalized.includes("fal.media") ||
    normalized.includes("storage upload failed") ||
    normalized.includes("artifact") ||
    normalized.includes("download")
  );
}

export function addStorageNetworkHint(message: string): string {
  if (!looksLikeStorageTimeout(message)) {
    return message;
  }
  return `${message} Local fal object storage appears unreachable from this environment. Check connectivity to fal media hosts such as v3b.fal.media.`;
}

export function summarizeRunTransferIssue(run: RunRecord | null): string | null {
  if (!run) {
    return null;
  }

  const uploadIssue = (run.uploads ?? []).find(upload => typeof upload.error === "string" && upload.error.trim() !== "");
  if (uploadIssue?.error) {
    return addStorageNetworkHint(uploadIssue.error);
  }

  const artifactIssue = (run.artifactIssues ?? []).find((issue: ArtifactIssue) => issue.severity === "error");
  if (artifactIssue?.message) {
    return addStorageNetworkHint(artifactIssue.message);
  }

  return null;
}
