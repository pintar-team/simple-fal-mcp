import path from "node:path";

import { z } from "zod";

import { inspectLocalFile } from "../../media/inspect.js";
import { convertImage, resizeImage, type ImageFit, type ImageOutputFormat } from "../../media/images.js";
import { resolveInputPath, resolveOutputPath } from "../../media/paths.js";
import {
  concatAudio,
  concatVideos,
  convertAudio,
  convertVideo,
  extractFrame,
  muxAudioTrack,
  trimVideo,
  type AudioCodec,
  type AudioOutputFormat,
  type VideoCodec,
  type VideoOutputFormat
} from "../../media/video.js";
import { okResponse, type FalToolContext } from "../shared.js";

const imageFormats = ["png", "jpeg", "jpg", "webp", "avif", "tiff"] as const;
const frameFormats = ["png", "jpg", "webp"] as const;
const videoFormats = ["mp4", "mov", "webm"] as const;
const audioFormats = ["mp3", "wav", "m4a"] as const;
const imageFits = ["cover", "contain", "fill", "inside", "outside"] as const;
const videoCodecs = ["h264", "hevc", "vp9", "copy"] as const;
const audioCodecs = ["aac", "opus", "mp3", "pcm", "copy", "none"] as const;

const mediaSchema = z.object({
  action: z.enum([
    "inspect",
    "image_convert",
    "image_resize",
    "video_convert",
    "video_trim",
    "video_concat",
    "extract_frame",
    "mux_audio",
    "audio_convert",
    "audio_concat"
  ]),
  inputPath: z.string().optional(),
  inputPaths: z.array(z.string()).optional(),
  videoPath: z.string().optional(),
  audioPath: z.string().optional(),
  outputPath: z.string().optional(),
  workspaceId: z.string().optional(),
  workspaceLabel: z.string().optional(),
  format: z.enum([
    ...imageFormats,
    ...frameFormats,
    ...videoFormats,
    ...audioFormats
  ]).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  fit: z.enum(imageFits).optional(),
  quality: z.number().int().min(1).max(100).optional(),
  startSeconds: z.number().nonnegative().optional(),
  durationSeconds: z.number().positive().optional(),
  timeSeconds: z.number().nonnegative().optional(),
  fps: z.number().positive().optional(),
  videoCodec: z.enum(videoCodecs).optional(),
  audioCodec: z.enum(audioCodecs).optional()
});

function requireString(value: string | undefined, field: string): string {
  if (!value || value.trim() === "") {
    throw new Error(`fal_media requires ${field}.`);
  }
  return value;
}

function requireAtLeastTwo(value: string[] | undefined, field: string): string[] {
  if (!value || value.length < 2) {
    throw new Error(`fal_media requires at least two ${field}.`);
  }
  return value;
}

function stemFromPath(filePath: string): string {
  return path.basename(filePath, path.extname(filePath)) || "media";
}

function preserveOrUseFormat(inputPath: string, format: string | undefined, fallback: string): string {
  if (format) {
    return format === "jpg" ? "jpeg" : format;
  }
  const ext = path.extname(inputPath).replace(/^\./, "").toLowerCase();
  return ext || fallback;
}

export function registerFalMediaTool(context: FalToolContext): void {
  context.server.registerTool(
    "fal_media",
    {
      title: "fal media postprocess",
      description: "Typed local media operations for files from fal workspaces or other local paths, including inspect, image conversion, resizing, video conversion, trim, concat, frame extraction, audio mux, and audio conversion.",
      inputSchema: mediaSchema
    },
    async input => {
      await context.reloadRuntime("fal_media");
      const runtime = context.getRuntime();
      let state = context.getPersistedState();

      if (input.action === "inspect") {
        const inputPath = resolveInputPath(
          runtime,
          requireString(input.inputPath ?? input.videoPath ?? input.audioPath, "inputPath"),
          input.workspaceId
        );
        return okResponse({
          ok: true,
          action: "inspect",
          inputPath,
          inspection: await inspectLocalFile(inputPath)
        });
      }

      const persistWorkspaceState = async (
        options: Parameters<typeof resolveOutputPath>[2]
      ): Promise<{ outputPath: string; workspaceId?: string; workspacePath?: string }> => {
        const resolved = await resolveOutputPath(runtime, state, options);
        if (resolved.state !== state) {
          state = await context.savePersistedState(resolved.state, "fal_media_workspace");
        }
        return {
          outputPath: resolved.outputPath,
          workspaceId: resolved.workspaceId,
          workspacePath: resolved.workspacePath
        };
      };

      if (input.action === "image_convert") {
        const inputPath = resolveInputPath(runtime, requireString(input.inputPath, "inputPath"), input.workspaceId);
        const format = (input.format as ImageOutputFormat | undefined) ?? "webp";
        const output = await persistWorkspaceState({
          outputPath: input.outputPath,
          workspaceId: input.workspaceId,
          workspaceLabel: input.workspaceLabel,
          baseName: `${stemFromPath(inputPath)}-convert`,
          extension: format === "jpg" ? "jpg" : format
        });
        await convertImage(inputPath, output.outputPath, format, input.quality);
        return okResponse({
          ok: true,
          action: "image_convert",
          inputPath,
          outputPath: output.outputPath,
          workspaceId: output.workspaceId ?? null,
          inspection: await inspectLocalFile(output.outputPath)
        });
      }

      if (input.action === "image_resize") {
        const inputPath = resolveInputPath(runtime, requireString(input.inputPath, "inputPath"), input.workspaceId);
        if (!input.width && !input.height) {
          throw new Error("fal_media action=image_resize requires width or height.");
        }
        const format = preserveOrUseFormat(inputPath, input.format, "webp");
        const output = await persistWorkspaceState({
          outputPath: input.outputPath,
          workspaceId: input.workspaceId,
          workspaceLabel: input.workspaceLabel,
          baseName: `${stemFromPath(inputPath)}-resize`,
          extension: format
        });
        await resizeImage(inputPath, output.outputPath, {
          width: input.width,
          height: input.height,
          fit: input.fit as ImageFit | undefined,
          format: input.format as ImageOutputFormat | undefined,
          quality: input.quality
        });
        return okResponse({
          ok: true,
          action: "image_resize",
          inputPath,
          outputPath: output.outputPath,
          workspaceId: output.workspaceId ?? null,
          inspection: await inspectLocalFile(output.outputPath)
        });
      }

      if (input.action === "video_convert") {
        const inputPath = resolveInputPath(runtime, requireString(input.inputPath, "inputPath"), input.workspaceId);
        const format = (input.format as VideoOutputFormat | undefined) ?? "mp4";
        const output = await persistWorkspaceState({
          outputPath: input.outputPath,
          workspaceId: input.workspaceId,
          workspaceLabel: input.workspaceLabel,
          baseName: `${stemFromPath(inputPath)}-convert`,
          extension: format
        });
        await convertVideo(inputPath, output.outputPath, {
          format,
          fps: input.fps,
          videoCodec: input.videoCodec as VideoCodec | undefined,
          audioCodec: input.audioCodec as AudioCodec | undefined
        });
        return okResponse({
          ok: true,
          action: "video_convert",
          inputPath,
          outputPath: output.outputPath,
          workspaceId: output.workspaceId ?? null,
          inspection: await inspectLocalFile(output.outputPath)
        });
      }

      if (input.action === "video_trim") {
        const inputPath = resolveInputPath(runtime, requireString(input.inputPath, "inputPath"), input.workspaceId);
        const format = (input.format as VideoOutputFormat | undefined) ?? "mp4";
        const output = await persistWorkspaceState({
          outputPath: input.outputPath,
          workspaceId: input.workspaceId,
          workspaceLabel: input.workspaceLabel,
          baseName: `${stemFromPath(inputPath)}-trim`,
          extension: format
        });
        await trimVideo(inputPath, output.outputPath, {
          startSeconds: input.startSeconds ?? 0,
          durationSeconds: input.durationSeconds,
          format,
          videoCodec: input.videoCodec as VideoCodec | undefined,
          audioCodec: input.audioCodec as AudioCodec | undefined
        });
        return okResponse({
          ok: true,
          action: "video_trim",
          inputPath,
          outputPath: output.outputPath,
          workspaceId: output.workspaceId ?? null,
          inspection: await inspectLocalFile(output.outputPath)
        });
      }

      if (input.action === "video_concat") {
        const inputPaths = requireAtLeastTwo(input.inputPaths, "inputPaths")
          .map(item => resolveInputPath(runtime, item, input.workspaceId));
        const format = (input.format as VideoOutputFormat | undefined) ?? "mp4";
        const output = await persistWorkspaceState({
          outputPath: input.outputPath,
          workspaceId: input.workspaceId,
          workspaceLabel: input.workspaceLabel,
          baseName: "concat-video",
          extension: format
        });
        await concatVideos(inputPaths, output.outputPath, {
          format,
          videoCodec: input.videoCodec as VideoCodec | undefined,
          audioCodec: input.audioCodec as AudioCodec | undefined
        });
        return okResponse({
          ok: true,
          action: "video_concat",
          inputPaths,
          outputPath: output.outputPath,
          workspaceId: output.workspaceId ?? null,
          inspection: await inspectLocalFile(output.outputPath)
        });
      }

      if (input.action === "extract_frame") {
        const inputPath = resolveInputPath(runtime, requireString(input.inputPath, "inputPath"), input.workspaceId);
        const format = (input.format as typeof frameFormats[number] | undefined) ?? "png";
        const output = await persistWorkspaceState({
          outputPath: input.outputPath,
          workspaceId: input.workspaceId,
          workspaceLabel: input.workspaceLabel,
          baseName: `${stemFromPath(inputPath)}-frame`,
          extension: format
        });
        await extractFrame(inputPath, output.outputPath, {
          timeSeconds: input.timeSeconds ?? input.startSeconds ?? 0
        });
        return okResponse({
          ok: true,
          action: "extract_frame",
          inputPath,
          outputPath: output.outputPath,
          workspaceId: output.workspaceId ?? null,
          inspection: await inspectLocalFile(output.outputPath)
        });
      }

      if (input.action === "mux_audio") {
        const videoPath = resolveInputPath(runtime, requireString(input.videoPath, "videoPath"), input.workspaceId);
        const audioPath = resolveInputPath(runtime, requireString(input.audioPath, "audioPath"), input.workspaceId);
        const format = (input.format as VideoOutputFormat | undefined) ?? "mp4";
        const output = await persistWorkspaceState({
          outputPath: input.outputPath,
          workspaceId: input.workspaceId,
          workspaceLabel: input.workspaceLabel,
          baseName: `${stemFromPath(videoPath)}-muxed`,
          extension: format
        });
        await muxAudioTrack(videoPath, audioPath, output.outputPath, {
          format,
          audioCodec: input.audioCodec as AudioCodec | undefined
        });
        return okResponse({
          ok: true,
          action: "mux_audio",
          videoPath,
          audioPath,
          outputPath: output.outputPath,
          workspaceId: output.workspaceId ?? null,
          inspection: await inspectLocalFile(output.outputPath)
        });
      }

      if (input.action === "audio_convert") {
        const inputPath = resolveInputPath(runtime, requireString(input.inputPath, "inputPath"), input.workspaceId);
        const format = (input.format as AudioOutputFormat | undefined) ?? "mp3";
        const output = await persistWorkspaceState({
          outputPath: input.outputPath,
          workspaceId: input.workspaceId,
          workspaceLabel: input.workspaceLabel,
          baseName: `${stemFromPath(inputPath)}-audio`,
          extension: format
        });
        await convertAudio(inputPath, output.outputPath, {
          format,
          audioCodec: input.audioCodec as AudioCodec | undefined
        });
        return okResponse({
          ok: true,
          action: "audio_convert",
          inputPath,
          outputPath: output.outputPath,
          workspaceId: output.workspaceId ?? null,
          inspection: await inspectLocalFile(output.outputPath)
        });
      }

      const inputPaths = requireAtLeastTwo(input.inputPaths, "inputPaths")
        .map(item => resolveInputPath(runtime, item, input.workspaceId));
      const format = (input.format as AudioOutputFormat | undefined) ?? "mp3";
      const output = await persistWorkspaceState({
        outputPath: input.outputPath,
        workspaceId: input.workspaceId,
        workspaceLabel: input.workspaceLabel,
        baseName: "concat-audio",
        extension: format
      });
      await concatAudio(inputPaths, output.outputPath, {
        format,
        audioCodec: input.audioCodec as AudioCodec | undefined
      });
      return okResponse({
        ok: true,
        action: "audio_concat",
        inputPaths,
        outputPath: output.outputPath,
        workspaceId: output.workspaceId ?? null,
        inspection: await inspectLocalFile(output.outputPath)
      });
    }
  );
}
