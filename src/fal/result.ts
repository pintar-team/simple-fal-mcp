import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ArtifactIssue, ArtifactRecord } from "../runtime.js";
import { downloadUrlToBuffer } from "./transfer.js";

type JsonRecord = Record<string, unknown>;
type ArtifactCandidate = {
  pointer: string;
  sourceKind: "remote" | "inline_data";
  sourceUrl: string;
};

export type ArtifactMaterializationResult = {
  artifacts: ArtifactRecord[];
  artifactIssues: ArtifactIssue[];
  publicPayload: unknown;
};

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function sanitizePart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "artifact";
}

function normalizePointer(pathParts: string[]): string {
  return `/${pathParts.map(part => part.replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`;
}

function collectArtifacts(value: unknown, pathParts: string[] = [], output: ArtifactCandidate[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectArtifacts(item, [...pathParts, String(index)], output));
    return;
  }
  const record = asRecord(value);
  if (!record) {
    return;
  }
  if (typeof record.url === "string") {
    if (/^https?:\/\//.test(record.url)) {
      output.push({
        pointer: normalizePointer(pathParts),
        sourceKind: "remote",
        sourceUrl: record.url
      });
    } else if (/^data:/i.test(record.url)) {
      output.push({
        pointer: normalizePointer(pathParts),
        sourceKind: "inline_data",
        sourceUrl: record.url
      });
    }
  }
  for (const [key, child] of Object.entries(record)) {
    collectArtifacts(child, [...pathParts, key], output);
  }
}

function extensionFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const ext = path.extname(pathname);
    return ext || "";
  } catch {
    return "";
  }
}

function extensionFromContentType(contentType: string | null): string {
  if (!contentType) {
    return "";
  }
  if (contentType.includes("png")) {
    return ".png";
  }
  if (contentType.includes("jpeg")) {
    return ".jpg";
  }
  if (contentType.includes("webp")) {
    return ".webp";
  }
  if (contentType.includes("gif")) {
    return ".gif";
  }
  if (contentType.includes("mp4")) {
    return ".mp4";
  }
  if (contentType.includes("mpeg")) {
    return ".mp3";
  }
  if (contentType.includes("wav")) {
    return ".wav";
  }
  if (contentType.includes("json")) {
    return ".json";
  }
  return "";
}

function parseDataUrl(sourceUrl: string): { contentType: string | null; buffer: Buffer } {
  const commaIndex = sourceUrl.indexOf(",");
  if (!sourceUrl.startsWith("data:") || commaIndex < 0) {
    throw new Error("Invalid data URL.");
  }

  const metadata = sourceUrl.slice(5, commaIndex);
  const payload = sourceUrl.slice(commaIndex + 1);
  const metadataParts = metadata.split(";").filter(Boolean);
  const firstPart = metadataParts[0];
  const contentType = firstPart && !firstPart.includes("=")
    ? firstPart
    : null;
  const isBase64 = metadataParts.includes("base64");

  if (isBase64) {
    return {
      contentType,
      buffer: Buffer.from(payload, "base64")
    };
  }

  return {
    contentType,
    buffer: Buffer.from(decodeURIComponent(payload), "utf8")
  };
}

function fileNameForArtifact(index: number, pointer: string, suffix: string): string {
  return `${String(index + 1).padStart(2, "0")}-${sanitizePart(pointer)}${suffix}`;
}

function buildPublicPayload(
  payload: unknown,
  artifactsByPointer: Map<string, ArtifactRecord>,
  inlineIssueByPointer: Map<string, ArtifactIssue[]>,
  pathParts: string[] = []
): unknown {
  if (Array.isArray(payload)) {
    return payload.map((item, index) => buildPublicPayload(item, artifactsByPointer, inlineIssueByPointer, [...pathParts, String(index)]));
  }

  if (typeof payload === "string" && /^data:/i.test(payload)) {
    return "[inline data omitted from MCP response]";
  }

  const record = asRecord(payload);
  if (!record) {
    return payload;
  }

  const pointer = normalizePointer(pathParts);
  const artifact = artifactsByPointer.get(pointer);
  const issues = inlineIssueByPointer.get(pointer) ?? [];
  const output: JsonRecord = {};
  for (const [key, child] of Object.entries(record)) {
    if (key === "url" && typeof child === "string" && /^data:/i.test(child)) {
      output[key] = artifact?.localPath ?? "[inline data omitted from MCP response]";
      continue;
    }
    output[key] = buildPublicPayload(child, artifactsByPointer, inlineIssueByPointer, [...pathParts, key]);
  }

  if (artifact && output.local_path === undefined) {
    output.local_path = artifact.localPath;
  }
  if (issues.length > 0 && output.inline_artifact_note === undefined) {
    output.inline_artifact_note = issues.map(issue => issue.message).join(" ");
  }

  return output;
}

export function buildPublicResultPayload(
  payload: unknown,
  artifacts: ArtifactRecord[] = [],
  artifactIssues: ArtifactIssue[] = []
): unknown {
  const artifactsByPointer = new Map(artifacts.map(artifact => [artifact.pointer, artifact]));
  const inlineIssueByPointer = new Map<string, ArtifactIssue[]>();
  for (const issue of artifactIssues) {
    if (issue.sourceKind !== "inline_data") {
      continue;
    }
    const items = inlineIssueByPointer.get(issue.pointer) ?? [];
    items.push(issue);
    inlineIssueByPointer.set(issue.pointer, items);
  }
  return buildPublicPayload(payload, artifactsByPointer, inlineIssueByPointer);
}

export async function materializeArtifactsToWorkspace(
  payload: unknown,
  artifactsDir: string,
  limit: number,
  downloadOutputs: boolean
): Promise<ArtifactMaterializationResult> {
  const found: ArtifactCandidate[] = [];
  collectArtifacts(payload, [], found);

  const artifacts: ArtifactRecord[] = [];
  const artifactIssues: ArtifactIssue[] = [];
  const maxArtifacts = Math.max(0, limit);

  if (downloadOutputs && found.length > 0 && maxArtifacts > 0) {
    await mkdir(artifactsDir, { recursive: true });
  }

  for (const item of found) {
    const canMaterialize = downloadOutputs && artifacts.length < maxArtifacts;
    if (item.sourceKind === "inline_data" && !canMaterialize) {
      artifactIssues.push({
        pointer: item.pointer,
        sourceKind: item.sourceKind,
        severity: "warning",
        message: downloadOutputs
          ? `Inline artifact omitted because artifact download limit ${maxArtifacts} was reached.`
          : "Inline artifact omitted because downloadOutputs is disabled."
      });
      continue;
    }
    if (!canMaterialize) {
      continue;
    }

    try {
      if (item.sourceKind === "remote") {
        const downloaded = await downloadUrlToBuffer(item.sourceUrl);
        const contentType = downloaded.contentType ?? null;
        const buffer = downloaded.buffer;
        const suffix = extensionFromUrl(item.sourceUrl) || extensionFromContentType(contentType);
        const localPath = path.join(artifactsDir, fileNameForArtifact(artifacts.length, item.pointer, suffix));
        await writeFile(localPath, buffer);
        artifacts.push({
          pointer: item.pointer,
          sourceKind: item.sourceKind,
          sourceUrl: item.sourceUrl,
          localPath,
          contentType: contentType ?? undefined,
          size: buffer.byteLength
        });
        continue;
      }

      const decoded = parseDataUrl(item.sourceUrl);
      const suffix = extensionFromContentType(decoded.contentType);
      const localPath = path.join(artifactsDir, fileNameForArtifact(artifacts.length, item.pointer, suffix));
      await writeFile(localPath, decoded.buffer);
      artifacts.push({
        pointer: item.pointer,
        sourceKind: item.sourceKind,
        localPath,
        contentType: decoded.contentType ?? undefined,
        size: decoded.buffer.byteLength
      });
    } catch (error) {
      artifactIssues.push({
        pointer: item.pointer,
        sourceKind: item.sourceKind,
        sourceUrl: item.sourceKind === "remote" ? item.sourceUrl : undefined,
        severity: "error",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return {
    artifacts,
    artifactIssues,
    publicPayload: buildPublicResultPayload(payload, artifacts, artifactIssues)
  };
}

export function setJsonPointer(root: Record<string, unknown>, pointer: string, value: unknown): void {
  if (!pointer.startsWith("/")) {
    throw new Error(`Invalid JSON pointer "${pointer}".`);
  }

  const parts = pointer
    .slice(1)
    .split("/")
    .map(part => part.replace(/~1/g, "/").replace(/~0/g, "~"));

  let current: unknown = root;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    const isLast = index === parts.length - 1;
    if (Array.isArray(current)) {
      const arrayIndex = Number.parseInt(part, 10);
      if (!Number.isFinite(arrayIndex) || arrayIndex < 0) {
        throw new Error(`Invalid array index "${part}" in pointer "${pointer}".`);
      }
      if (isLast) {
        current[arrayIndex] = value;
        return;
      }
      if (current[arrayIndex] === undefined) {
        const nextPart = parts[index + 1];
        current[arrayIndex] = /^\d+$/.test(nextPart ?? "") ? [] : {};
      }
      current = current[arrayIndex];
      continue;
    }

    const record = asRecord(current);
    if (!record) {
      throw new Error(`Pointer "${pointer}" does not resolve to an object path.`);
    }
    if (isLast) {
      record[part] = value;
      return;
    }
    if (record[part] === undefined) {
      const nextPart = parts[index + 1];
      record[part] = /^\d+$/.test(nextPart ?? "") ? [] : {};
    }
    current = record[part];
  }
}
