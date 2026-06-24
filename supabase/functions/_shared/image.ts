/**
 * 图像处理助手（缩略图生成，第 03 篇 assets.thumbnail_path / 第 05 篇完成阶段）。
 *
 * 在 Deno 边缘运行时以纯 WASM 的 imagescript 解码、缩放、重新编码，无需原生依赖。
 * 缩略图统一编码为 PNG，最长边不超过 {@link THUMB_MAX}px，按比例缩放。
 *
 * 视频无法在边缘以图像库抽帧（需 ffmpeg 级能力，超出边缘运行约束），故视频缩略图
 * 仅在提供商回传封面帧时由上层另行处理，此处只服务图像。
 *
 * @module functions/_shared/image
 */

// 注意：imagescript 仅在缩略图生成时按需动态加载（见 makeImageThumbnail）。
// 改为动态 import 的关键原因：其源在 deno.land——在被网络阻断（如 GFW）的环境里，
// 顶层静态 import 会让「凡是经流水线引用到本模块的边缘函数」整体编译失败，进而退回旧的
// 已缓存编译版（新代码永远不生效）。动态 import 把这条远端依赖移出静态依赖图：核心流程
// 无需触达 deno.land 即可编译运行；缩略图不可用时静默回退（不阻断生成）。

/** 缩略图最长边像素上限。 */
const THUMB_MAX = 512;

/** 生成的缩略图 MIME。 */
export const THUMBNAIL_MIME = 'image/png';

/** 缩略图结果。 */
export interface ThumbnailResult {
  bytes: Uint8Array;
  width: number;
  height: number;
}

/**
 * 为图片字节生成等比缩略图（PNG）。
 *
 * 解码失败、动图（GIF）或不支持的格式返回 null，由调用方决定是否回退（不阻断主流程）。
 *
 * @param bytes - 原图字节（PNG / JPEG / 等 imagescript 可解码格式）
 * @returns 缩略图字节与尺寸，或 null
 */
export async function makeImageThumbnail(bytes: Uint8Array): Promise<ThumbnailResult | null> {
  try {
    // 按需动态加载 imagescript（远端依赖移出静态依赖图，见文件头说明）
    const { decode, Image } = await import('https://deno.land/x/imagescript@1.2.17/mod.ts');
    const decoded = await decode(bytes);
    if (!(decoded instanceof Image)) return null; // 动图等暂不生成缩略图
    const longest = Math.max(decoded.width, decoded.height);
    const scale = longest > THUMB_MAX ? THUMB_MAX / longest : 1;
    const width = Math.max(1, Math.round(decoded.width * scale));
    const height = Math.max(1, Math.round(decoded.height * scale));
    const thumb = scale < 1 ? decoded.resize(width, height) : decoded;
    const out = await thumb.encode(); // PNG 字节
    return { bytes: out, width, height };
  } catch {
    return null;
  }
}
