import { mkdir } from "node:fs/promises";
import path from "node:path";

import { ensureWorkspace, getWorkspacePath } from "../fal/workspaces.js";
import type { PersistedState, RuntimeConfig } from "../runtime.js";

function sanitizeSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "media";
}

export type ResolvedWorkspaceTarget = {
  workspaceId: string;
  workspacePath: string;
  state: PersistedState;
};

export async function ensureWorkspaceTarget(
  runtime: RuntimeConfig,
  state: PersistedState,
  workspaceId?: string,
  workspaceLabel?: string
): Promise<ResolvedWorkspaceTarget> {
  const workspace = await ensureWorkspace(runtime, state, workspaceId, workspaceLabel ?? "media");
  return {
    workspaceId: workspace.entry.workspaceId,
    workspacePath: workspace.entry.path,
    state: workspace.state
  };
}

export function resolveInputPath(
  runtime: RuntimeConfig,
  inputPath: string,
  workspaceId?: string
): string {
  if (path.isAbsolute(inputPath)) {
    return path.resolve(inputPath);
  }
  if (!workspaceId) {
    throw new Error(`Relative inputPath requires workspaceId: ${inputPath}`);
  }
  return path.resolve(getWorkspacePath(runtime, workspaceId), inputPath);
}

export async function resolveOutputPath(
  runtime: RuntimeConfig,
  state: PersistedState,
  options: {
    outputPath?: string;
    workspaceId?: string;
    workspaceLabel?: string;
    baseName: string;
    extension: string;
  }
): Promise<{
  outputPath: string;
  workspaceId?: string;
  workspacePath?: string;
  state: PersistedState;
}> {
  const normalizedExtension = options.extension.startsWith(".")
    ? options.extension
    : `.${options.extension}`;

  if (options.outputPath && path.isAbsolute(options.outputPath)) {
    const resolved = path.resolve(options.outputPath);
    await mkdir(path.dirname(resolved), { recursive: true });
    return {
      outputPath: resolved,
      state
    };
  }

  const workspace = await ensureWorkspaceTarget(
    runtime,
    state,
    options.workspaceId,
    options.workspaceLabel
  );
  const mediaDir = path.join(workspace.workspacePath, "media");
  await mkdir(mediaDir, { recursive: true });

  const outputPath = options.outputPath && options.outputPath.trim() !== ""
    ? path.resolve(workspace.workspacePath, options.outputPath)
    : path.join(
        mediaDir,
        `${new Date().toISOString().replace(/[:.]/g, "-")}-${sanitizeSegment(options.baseName)}${normalizedExtension}`
      );

  await mkdir(path.dirname(outputPath), { recursive: true });
  return {
    outputPath,
    workspaceId: workspace.workspaceId,
    workspacePath: workspace.workspacePath,
    state: workspace.state
  };
}
