import { basename, extname } from "node:path";
import { readFile } from "node:fs/promises";

import type { RunUploadRecord, RuntimeConfig } from "../runtime.js";
import { falApiRequest } from "./client.js";
import { uploadBufferToUrl } from "./transfer.js";
import { setJsonPointer } from "./result.js";

const INLINE_DATA_FALLBACK_LIMIT = 8 * 1024 * 1024;

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

type InitiatedUpload = {
  file_url: string;
  upload_url: string;
};

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

function buildInlineDataUrl(buffer: Buffer, contentType: string): string {
  return `data:${contentType};base64,${buffer.toString("base64")}`;
}

function previewResolvedValue(kind: "remote_url" | "inline_data", value: string): string {
  if (kind === "remote_url") {
    return value;
  }
  const prefix = value.slice(0, Math.min(64, value.indexOf(",") > 0 ? value.indexOf(",") : 64));
  return `${prefix},...`;
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

async function initiateUpload(
  apiKey: string,
  runtime: RuntimeConfig,
  localPath: string,
  contentType: string
): Promise<InitiatedUpload> {
  return await falApiRequest<InitiatedUpload>("storage/upload/initiate", {
    apiKey,
    query: {
      storage_type: "fal-cdn-v3"
    },
    headers: {
      "X-Fal-Object-Lifecycle": JSON.stringify({
        expiration_duration_seconds: runtime.defaults.objectTtlSeconds,
        allow_io_storage: true
      })
    },
    body: {
      content_type: contentType,
      file_name: basename(localPath)
    }
  });
}

async function resolveUpload(
  apiKey: string,
  runtime: RuntimeConfig,
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
    const initiated = await initiateUpload(apiKey, runtime, request.localPath, contentType);
    await uploadBufferToUrl(initiated.upload_url, buffer, contentType);
    return {
      value: initiated.file_url,
      record: {
        inputPath: request.inputPath,
        localPath: request.localPath,
        status: "uploaded",
        resolvedValueKind: "remote_url",
        resolvedValuePreview: previewResolvedValue("remote_url", initiated.file_url),
        contentType,
        size: buffer.byteLength
      }
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (buffer.byteLength <= INLINE_DATA_FALLBACK_LIMIT) {
      const dataUrl = buildInlineDataUrl(buffer, contentType);
      return {
        value: dataUrl,
        record: {
          inputPath: request.inputPath,
          localPath: request.localPath,
          status: "embedded_data",
          resolvedValueKind: "inline_data",
          resolvedValuePreview: previewResolvedValue("inline_data", dataUrl),
          contentType,
          size: buffer.byteLength,
          error: `Storage upload failed, fell back to inline data: ${message}`
        }
      };
    }
    throw new PreparedUploadError(
      `Storage upload failed for ${request.inputPath}`,
      [{
        inputPath: request.inputPath,
        localPath: request.localPath,
        status: "failed",
        contentType,
        size: buffer.byteLength,
        error: `Storage upload failed and inline fallback was too large: ${message}`
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
