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

/** 无需远端 WASM 即可读取的栅格文件元数据。 */
export interface RasterImageMetadata {
  width: number | null;
  height: number | null;
  /** true 表示至少一个像素实际透明；false 表示已验证全不透明；null 表示格式无法验证。 */
  hasTransparency: boolean | null;
}

/** 读取无符号大端整数。 */
function uint32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, false);
}

/** PNG Paeth 滤镜预测器。 */
function paeth(left: number, up: number, upperLeft: number): number {
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const diagonalDistance = Math.abs(estimate - upperLeft);
  return leftDistance <= upDistance && leftDistance <= diagonalDistance
    ? left
    : upDistance <= diagonalDistance
    ? up
    : upperLeft;
}

/** 解码 PNG 非交错扫描行滤镜；失败返回 null。 */
async function decodePngRows(
  compressed: Uint8Array,
  height: number,
  rowBytes: number,
  filterBytesPerPixel: number,
): Promise<Uint8Array[] | null> {
  try {
    const compressedBuffer = compressed.slice().buffer as ArrayBuffer;
    const stream = new Blob([compressedBuffer])
      .stream()
      .pipeThrough(new DecompressionStream('deflate'));
    const raw = new Uint8Array(await new Response(stream).arrayBuffer());
    if (raw.byteLength < height * (rowBytes + 1)) return null;
    const rows: Uint8Array[] = [];
    let offset = 0;
    for (let y = 0; y < height; y += 1) {
      const filter = raw[offset++]!;
      const encoded = raw.subarray(offset, offset + rowBytes);
      offset += rowBytes;
      const row = new Uint8Array(rowBytes);
      const previous = rows[y - 1];
      for (let x = 0; x < rowBytes; x += 1) {
        const left = x >= filterBytesPerPixel ? row[x - filterBytesPerPixel]! : 0;
        const up = previous?.[x] ?? 0;
        const upperLeft = x >= filterBytesPerPixel ? previous?.[x - filterBytesPerPixel] ?? 0 : 0;
        const predictor = filter === 0
          ? 0
          : filter === 1
          ? left
          : filter === 2
          ? up
          : filter === 3
          ? Math.floor((left + up) / 2)
          : filter === 4
          ? paeth(left, up, upperLeft)
          : Number.NaN;
        if (!Number.isFinite(predictor)) return null;
        row[x] = (encoded[x]! + predictor) & 0xff;
      }
      rows.push(row);
    }
    return rows;
  } catch {
    return null;
  }
}

/** 解析 PNG 尺寸，并验证是否至少存在一个透明像素。 */
async function inspectPng(bytes: Uint8Array): Promise<RasterImageMetadata | null> {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 33 || !signature.every((value, index) => bytes[index] === value)) return null;

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = -1;
  const idatChunks: Uint8Array[] = [];
  let transparencyTable: Uint8Array | null = null;
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = uint32(bytes, offset);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) return null;
    const type = new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8));
    const data = bytes.subarray(dataStart, dataEnd);
    if (type === 'IHDR' && length === 13) {
      width = uint32(data, 0);
      height = uint32(data, 4);
      bitDepth = data[8]!;
      colorType = data[9]!;
      interlace = data[12]!;
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'tRNS') {
      transparencyTable = data;
    } else if (type === 'IEND') {
      break;
    }
    offset = dataEnd + 4;
  }
  if (width <= 0 || height <= 0) return null;
  if (interlace !== 0 || bitDepth !== 8 || idatChunks.length === 0) {
    return { width, height, hasTransparency: null };
  }

  const components = colorType === 6 ? 4 : colorType === 4 ? 2 : colorType === 2 ? 3 : 1;
  const rowBytes = width * components;
  const compressedLength = idatChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const compressed = new Uint8Array(compressedLength);
  let writeOffset = 0;
  for (const chunk of idatChunks) {
    compressed.set(chunk, writeOffset);
    writeOffset += chunk.length;
  }
  const rows = await decodePngRows(compressed, height, rowBytes, components);
  if (!rows) return { width, height, hasTransparency: null };

  if (colorType === 6 || colorType === 4) {
    const alphaOffset = colorType === 6 ? 3 : 1;
    return {
      width,
      height,
      hasTransparency: rows.some((row) => {
        for (let index = alphaOffset; index < row.length; index += components) {
          if (row[index]! < 255) return true;
        }
        return false;
      }),
    };
  }
  if (colorType === 3 && transparencyTable) {
    return {
      width,
      height,
      hasTransparency: rows.some((row) =>
        row.some((paletteIndex) => (transparencyTable?.[paletteIndex] ?? 255) < 255)
      ),
    };
  }
  return { width, height, hasTransparency: false };
}

/** 解析 JPEG SOF 段尺寸。 */
function inspectJpeg(bytes: Uint8Array): RasterImageMetadata | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const sofMarkers = new Set([
    0xc0,
    0xc1,
    0xc2,
    0xc3,
    0xc5,
    0xc6,
    0xc7,
    0xc9,
    0xca,
    0xcb,
    0xcd,
    0xce,
    0xcf,
  ]);
  let offset = 2;
  while (offset + 9 < bytes.length) {
    while (offset < bytes.length && bytes[offset] !== 0xff) offset += 1;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++]!;
    if (marker === 0xd9 || marker === 0xda) break;
    if (offset + 2 > bytes.length) break;
    const length = (bytes[offset]! << 8) | bytes[offset + 1]!;
    if (length < 2 || offset + length > bytes.length) break;
    if (sofMarkers.has(marker) && length >= 7) {
      const height = (bytes[offset + 3]! << 8) | bytes[offset + 4]!;
      const width = (bytes[offset + 5]! << 8) | bytes[offset + 6]!;
      return { width, height, hasTransparency: false };
    }
    offset += length;
  }
  return null;
}

/**
 * 检查 PNG/JPEG 真实尺寸与透明性。未知格式不猜测透明输出，调用方可据此失败关闭。
 */
export async function inspectRasterImage(
  bytes: Uint8Array,
  mimeType: string,
): Promise<RasterImageMetadata> {
  const inspected = mimeType === 'image/png'
    ? await inspectPng(bytes)
    : mimeType === 'image/jpeg'
    ? inspectJpeg(bytes)
    : null;
  return inspected ?? { width: null, height: null, hasTransparency: null };
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
