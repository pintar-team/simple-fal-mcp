import { stat } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

import { runCommand } from "./command.js";

function parseNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export async function probeMedia(inputPath: string): Promise<Record<string, unknown> | null> {
  try {
    const result = await runCommand("ffprobe", [
      "-v",
      "quiet",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      inputPath
    ]);
    return JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function inspectLocalFile(inputPath: string): Promise<Record<string, unknown>> {
  const fileStat = await stat(inputPath);
  const extension = path.extname(inputPath).toLowerCase() || null;

  try {
    const metadata = await sharp(inputPath, { animated: true }).metadata();
    return {
      kind: "image",
      path: inputPath,
      file: {
        size: fileStat.size,
        extension
      },
      image: {
        format: metadata.format ?? null,
        width: metadata.width ?? null,
        height: metadata.height ?? null,
        space: metadata.space ?? null,
        channels: metadata.channels ?? null,
        density: metadata.density ?? null,
        hasAlpha: metadata.hasAlpha ?? null,
        isProgressive: metadata.isProgressive ?? null,
        pages: metadata.pages ?? null
      }
    };
  } catch {
    const probe = await probeMedia(inputPath);
    if (probe) {
      const streams = Array.isArray(probe.streams) ? probe.streams as Array<Record<string, unknown>> : [];
      const format = (probe.format && typeof probe.format === "object" ? probe.format : {}) as Record<string, unknown>;
      const videoStream = streams.find(stream => stream.codec_type === "video");
      const audioStream = streams.find(stream => stream.codec_type === "audio");
      return {
        kind: videoStream ? "video" : audioStream ? "audio" : "media",
        path: inputPath,
        file: {
          size: fileStat.size,
          extension
        },
        media: {
          formatName: format.format_name ?? null,
          durationSeconds: parseNumber(format.duration),
          bitRate: parseNumber(format.bit_rate),
          streams: streams.map(stream => ({
            type: stream.codec_type ?? null,
            codec: stream.codec_name ?? null,
            width: parseNumber(stream.width),
            height: parseNumber(stream.height),
            sampleRate: parseNumber(stream.sample_rate),
            channels: parseNumber(stream.channels),
            durationSeconds: parseNumber(stream.duration),
            avgFrameRate: stream.avg_frame_rate ?? null
          }))
        }
      };
    }

    return {
      kind: "file",
      path: inputPath,
      file: {
        size: fileStat.size,
        extension
      }
    };
  }
}
