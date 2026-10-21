import sharp from "sharp";

// Bound decoded memory and preserve the original size; never silently downsample.
export const CLIPBOARD_MAX_PIXELS = 25_000_000;
export async function decodeClipboardImage(original: string): Promise<Buffer> {
  try {
    return await sharp(original, { animated: false, page: 0, pages: 1, limitInputPixels: CLIPBOARD_MAX_PIXELS, failOn: "error" })
      .timeout({ seconds: 15 }).autoOrient().toColourspace("srgb").png().toBuffer();
  } catch (error) {
    const reason = error instanceof Error ? error.message : "";
    if (/pixel limit/i.test(reason)) throw new Error("图片过大，复制图片最多支持 2500 万像素；可使用复制文件。");
    throw new Error("无法解码这张图片，请检查原文件是否完整；可使用复制文件。");
  }
}
