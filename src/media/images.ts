import sharp from "sharp";

export type ImageOutputFormat = "png" | "jpeg" | "jpg" | "webp" | "avif" | "tiff";
export type ImageFit = "cover" | "contain" | "fill" | "inside" | "outside";

function normalizeFormat(format: ImageOutputFormat): Exclude<ImageOutputFormat, "jpg"> | "jpeg" {
  return format === "jpg" ? "jpeg" : format;
}

function applyOutputFormat(
  pipeline: sharp.Sharp,
  format: ImageOutputFormat,
  quality?: number
): sharp.Sharp {
  const normalized = normalizeFormat(format);
  switch (normalized) {
    case "png":
      return pipeline.png();
    case "jpeg":
      return pipeline.jpeg(quality ? { quality } : undefined);
    case "webp":
      return pipeline.webp(quality ? { quality } : undefined);
    case "avif":
      return pipeline.avif(quality ? { quality } : undefined);
    case "tiff":
      return pipeline.tiff(quality ? { quality } : undefined);
  }
}

export async function convertImage(
  inputPath: string,
  outputPath: string,
  format: ImageOutputFormat,
  quality?: number
): Promise<void> {
  const pipeline = sharp(inputPath, { animated: true });
  await applyOutputFormat(pipeline, format, quality).toFile(outputPath);
}

export async function resizeImage(
  inputPath: string,
  outputPath: string,
  options: {
    width?: number;
    height?: number;
    fit?: ImageFit;
    format?: ImageOutputFormat;
    quality?: number;
  }
): Promise<void> {
  const pipeline = sharp(inputPath, { animated: true }).resize({
    width: options.width,
    height: options.height,
    fit: options.fit ?? "inside",
    withoutEnlargement: true
  });

  if (options.format) {
    await applyOutputFormat(pipeline, options.format, options.quality).toFile(outputPath);
    return;
  }

  await pipeline.toFile(outputPath);
}
