import { unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runCommand } from "./command.js";

export type VideoOutputFormat = "mp4" | "mov" | "webm";
export type AudioOutputFormat = "mp3" | "wav" | "m4a";
export type VideoCodec = "h264" | "hevc" | "vp9" | "copy";
export type AudioCodec = "aac" | "opus" | "mp3" | "pcm" | "copy" | "none";

function mapVideoCodec(codec: VideoCodec | undefined, format: VideoOutputFormat): string[] {
  const normalized = codec ?? (format === "webm" ? "vp9" : "h264");
  switch (normalized) {
    case "copy":
      return ["-c:v", "copy"];
    case "hevc":
      return ["-c:v", "libx265"];
    case "vp9":
      return ["-c:v", "libvpx-vp9"];
    case "h264":
    default:
      return ["-c:v", "libx264", "-pix_fmt", "yuv420p"];
  }
}

function mapAudioCodec(codec: AudioCodec | undefined, format: VideoOutputFormat | AudioOutputFormat): string[] {
  const fallback = format === "webm" ? "opus" : format === "wav" ? "pcm" : format === "mp3" ? "mp3" : "aac";
  const normalized = codec ?? fallback;
  switch (normalized) {
    case "copy":
      return ["-c:a", "copy"];
    case "opus":
      return ["-c:a", "libopus"];
    case "mp3":
      return ["-c:a", "libmp3lame"];
    case "pcm":
      return ["-c:a", "pcm_s16le"];
    case "none":
      return ["-an"];
    case "aac":
    default:
      return ["-c:a", "aac"];
  }
}

export async function convertVideo(
  inputPath: string,
  outputPath: string,
  options: {
    format: VideoOutputFormat;
    videoCodec?: VideoCodec;
    audioCodec?: AudioCodec;
    fps?: number;
  }
): Promise<void> {
  const args = [
    "-y",
    "-i",
    inputPath
  ];
  if (options.fps) {
    args.push("-r", String(options.fps));
  }
  args.push(
    ...mapVideoCodec(options.videoCodec, options.format),
    ...mapAudioCodec(options.audioCodec, options.format),
    ...(options.format === "mp4" ? ["-movflags", "+faststart"] : []),
    outputPath
  );
  await runCommand("ffmpeg", args);
}

export async function trimVideo(
  inputPath: string,
  outputPath: string,
  options: {
    startSeconds: number;
    durationSeconds?: number;
    format: VideoOutputFormat;
    videoCodec?: VideoCodec;
    audioCodec?: AudioCodec;
  }
): Promise<void> {
  const args = [
    "-y",
    "-ss",
    String(options.startSeconds),
    "-i",
    inputPath
  ];
  if (options.durationSeconds) {
    args.push("-t", String(options.durationSeconds));
  }
  args.push(
    ...mapVideoCodec(options.videoCodec, options.format),
    ...mapAudioCodec(options.audioCodec, options.format),
    ...(options.format === "mp4" ? ["-movflags", "+faststart"] : []),
    outputPath
  );
  await runCommand("ffmpeg", args);
}

export async function concatVideos(
  inputPaths: string[],
  outputPath: string,
  options: {
    format: VideoOutputFormat;
    videoCodec?: VideoCodec;
    audioCodec?: AudioCodec;
  }
): Promise<void> {
  const listPath = path.join(os.tmpdir(), `simple-fal-mcp-concat-${Date.now()}.txt`);
  const listContent = inputPaths.map(item => `file '${item.replace(/'/g, "'\\''")}'`).join("\n");
  await writeFile(listPath, `${listContent}\n`, "utf8");
  try {
    await runCommand("ffmpeg", [
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listPath,
      ...mapVideoCodec(options.videoCodec, options.format),
      ...mapAudioCodec(options.audioCodec, options.format),
      ...(options.format === "mp4" ? ["-movflags", "+faststart"] : []),
      outputPath
    ]);
  } finally {
    await unlink(listPath).catch(() => {});
  }
}

export async function extractFrame(
  inputPath: string,
  outputPath: string,
  options: {
    timeSeconds: number;
  }
): Promise<void> {
  await runCommand("ffmpeg", [
    "-y",
    "-ss",
    String(options.timeSeconds),
    "-i",
    inputPath,
    "-frames:v",
    "1",
    outputPath
  ]);
}

export async function muxAudioTrack(
  videoPath: string,
  audioPath: string,
  outputPath: string,
  options: {
    format: VideoOutputFormat;
    audioCodec?: AudioCodec;
  }
): Promise<void> {
  await runCommand("ffmpeg", [
    "-y",
    "-i",
    videoPath,
    "-i",
    audioPath,
    "-c:v",
    "copy",
    ...mapAudioCodec(options.audioCodec, options.format),
    "-shortest",
    ...(options.format === "mp4" ? ["-movflags", "+faststart"] : []),
    outputPath
  ]);
}

export async function convertAudio(
  inputPath: string,
  outputPath: string,
  options: {
    format: AudioOutputFormat;
    audioCodec?: AudioCodec;
  }
): Promise<void> {
  await runCommand("ffmpeg", [
    "-y",
    "-i",
    inputPath,
    ...mapAudioCodec(options.audioCodec, options.format),
    outputPath
  ]);
}

export async function concatAudio(
  inputPaths: string[],
  outputPath: string,
  options: {
    format: AudioOutputFormat;
    audioCodec?: AudioCodec;
  }
): Promise<void> {
  const listPath = path.join(os.tmpdir(), `simple-fal-mcp-audio-concat-${Date.now()}.txt`);
  const listContent = inputPaths.map(item => `file '${item.replace(/'/g, "'\\''")}'`).join("\n");
  await writeFile(listPath, `${listContent}\n`, "utf8");
  try {
    await runCommand("ffmpeg", [
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listPath,
      ...mapAudioCodec(options.audioCodec, options.format),
      outputPath
    ]);
  } finally {
    await unlink(listPath).catch(() => {});
  }
}
