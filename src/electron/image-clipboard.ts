import { clipboard, nativeImage } from "electron";
import { decodeClipboardImage } from "./clipboard-image-decode.js";

/** Bitmap clipboard only. Animated images use their first frame. */
export async function copyImageToClipboard(original: string, target: Pick<typeof clipboard, "writeImage" | "readImage"> = clipboard): Promise<void> {
  const png = await decodeClipboardImage(original);
  const image = nativeImage.createFromBuffer(png);
  if (image.isEmpty()) throw new Error("无法创建图片剪贴板，请使用复制文件。");
  try {
    target.writeImage(image);
    if (target.readImage().isEmpty()) throw new Error("empty clipboard");
  } catch {
    throw new Error("图片剪贴板暂不可用，可能被其他程序占用，请重试。");
  }
}
