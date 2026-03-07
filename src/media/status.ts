import { isCommandAvailable } from "./command.js";

export async function getMediaCapabilities(): Promise<Record<string, boolean>> {
  const [ffmpeg, ffprobe, magick] = await Promise.all([
    isCommandAvailable("ffmpeg"),
    isCommandAvailable("ffprobe"),
    isCommandAvailable("magick")
  ]);

  return {
    ffmpeg,
    ffprobe,
    magick,
    sharp: true
  };
}
