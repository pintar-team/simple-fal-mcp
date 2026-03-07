import { extname } from "node:path";
import { readFile } from "node:fs/promises";

import type { RunUploadRecord, RuntimeConfig } from "../runtime.js";
import { createConfiguredFalClient } from "./client.js";
import { addStorageNetworkHint, formatErrorWithCauses } from "./diagnostics.js";
import { setJsonPointer } from "./result.js";

type UploadRequest = {
  inputPath: string;
  localPath: string;
};

class PreparedUploadError extends Error {
  readonly uploads: RunUploadRecord[];

  constructor(message: string, uploads: RunUploadRecord[]) {
    super(message);
    this.name = "PreparedUploadError";
    this.uploads = uploads;
  }
}

function guessContentType(localPath: string): string {
  const ext = extname(localPath).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".mp4":
      return "video/mp4";
    case ".mov":
      return "video/quicktime";
    case ".mp3":
      return "audio/mpeg";
    case ".wav":
      return "audio/wav";
    case ".json":
      return "application/json";
    default:
      return "application/octet-stream";
  }
}

function previewResolvedValue(value: string): string {
  return value;
}

function sanitizeInputForStorage(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(item => sanitizeInputForStorage(item));
  }
  if (typeof value === "string" && /^data:/i.test(value)) {
    return "[inline data omitted from saved request]";
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, sanitizeInputForStorage(child)])
    );
  }
  return value;
}

function toExactArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  ) as ArrayBuffer;
}

async function resolveUpload(
  apiKey: string,
  _runtime: RuntimeConfig,
  request: UploadRequest
): Promise<{ value: string; record: RunUploadRecord }> {
  const contentType = guessContentType(request.localPath);
  let buffer: Buffer;
  try {
    buffer = await readFile(request.localPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new PreparedUploadError(
      `Failed to read local file for ${request.inputPath}: ${message}`,
      [{
        inputPath: request.inputPath,
        localPath: request.localPath,
        status: "failed",
        contentType,
        error: `Failed to read local file: ${message}`
      }]
    );
  }

  try {
    const client = createConfiguredFalClient(apiKey);
    const file = new File([toExactArrayBuffer(buffer)], request.localPath.split(/[\\/]/).pop() ?? "upload.bin", {
      type: contentType
    });
    const uploadedUrl = await client.storage.upload(file);
    return {
      value: uploadedUrl,
      record: {
        inputPath: request.inputPath,
        localPath: request.localPath,
        status: "uploaded",
        resolvedValueKind: "remote_url",
        resolvedValuePreview: previewResolvedValue(uploadedUrl),
        contentType,
        size: buffer.byteLength
      }
    };
  } catch (error) {
    const message = addStorageNetworkHint(formatErrorWithCauses(error));
    throw new PreparedUploadError(
      `Storage upload failed for ${request.inputPath}`,
      [{
        inputPath: request.inputPath,
        localPath: request.localPath,
        status: "failed",
        contentType,
        size: buffer.byteLength,
        error: `Storage upload failed: ${message}`
      }]
    );
  }
}

export async function prepareInputUploads(
  apiKey: string,
  runtime: RuntimeConfig,
  input: Record<string, unknown>,
  uploadFiles: UploadRequest[]
): Promise<{
  preparedInput: Record<string, unknown>;
  sanitizedInput: Record<string, unknown>;
  uploads: RunUploadRecord[];
}> {
  const preparedInput = structuredClone(input);
  const uploads: RunUploadRecord[] = [];

  for (const upload of uploadFiles) {
    try {
      const resolved = await resolveUpload(apiKey, runtime, upload);
      setJsonPointer(preparedInput, upload.inputPath, resolved.value);
      uploads.push(resolved.record);
    } catch (error) {
      const appendedUploads = error instanceof PreparedUploadError
        ? [...uploads, ...error.uploads]
        : [
            ...uploads,
            {
              inputPath: upload.inputPath,
              localPath: upload.localPath,
              status: "failed",
              error: error instanceof Error ? error.message : String(error)
            } satisfies RunUploadRecord
          ];
      throw new PreparedUploadError(
        error instanceof Error ? error.message : `Upload failed for ${upload.localPath}`,
        appendedUploads
      );
    }
  }

  return {
    preparedInput,
    sanitizedInput: sanitizeInputForStorage(preparedInput) as Record<string, unknown>,
    uploads
  };
}
