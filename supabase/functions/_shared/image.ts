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

/** 透明背景合成结果。 */
export interface TransparentPngResult {
  /** 编码后的 RGBA PNG。 */
  bytes: Uint8Array;
  /** 输出自然宽度。 */
  width: number;
  /** 输出自然高度。 */
  height: number;
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

/** 已展开为 RGBA 的 8 位非交错 PNG。 */
interface DecodedPng {
  width: number;
  height: number;
  rgba: Uint8Array;
}

/** 拼接多个字节片段。 */
function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

/**
 * 解码 Edge 合成链路所需的标准 8 位非交错 PNG。
 *
 * 支持灰度、RGB、索引色、灰度 Alpha 与 RGBA；这些覆盖火山实体分割的原图与蒙版输出。
 */
async function decodePng(bytes: Uint8Array): Promise<DecodedPng> {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 33 || !signature.every((value, index) => bytes[index] === value)) {
    throw new Error('图片不是有效 PNG');
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = -1;
  let palette: Uint8Array | null = null;
  let transparency: Uint8Array | null = null;
  const idatChunks: Uint8Array[] = [];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = uint32(bytes, offset);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) throw new Error('PNG chunk 越界');
    const type = new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8));
    const data = bytes.subarray(dataStart, dataEnd);
    if (type === 'IHDR' && length === 13) {
      width = uint32(data, 0);
      height = uint32(data, 4);
      bitDepth = data[8]!;
      colorType = data[9]!;
      interlace = data[12]!;
    } else if (type === 'PLTE') {
      palette = data.slice();
    } else if (type === 'tRNS') {
      transparency = data.slice();
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset = dataEnd + 4;
  }

  const components = colorType === 0 || colorType === 3
    ? 1
    : colorType === 2
    ? 3
    : colorType === 4
    ? 2
    : colorType === 6
    ? 4
    : 0;
  if (
    width <= 0 ||
    height <= 0 ||
    bitDepth !== 8 ||
    interlace !== 0 ||
    components === 0 ||
    idatChunks.length === 0
  ) {
    throw new Error('仅支持标准 8 位非交错 PNG');
  }

  const rows = await decodePngRows(
    concatBytes(idatChunks),
    height,
    width * components,
    components,
  );
  if (!rows) throw new Error('PNG 像素数据解码失败');

  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const row = rows[y]!;
    for (let x = 0; x < width; x += 1) {
      const sourceOffset = x * components;
      const targetOffset = (y * width + x) * 4;
      if (colorType === 0) {
        const gray = row[sourceOffset]!;
        rgba.set([gray, gray, gray, 255], targetOffset);
      } else if (colorType === 2) {
        rgba.set(
          [row[sourceOffset]!, row[sourceOffset + 1]!, row[sourceOffset + 2]!, 255],
          targetOffset,
        );
      } else if (colorType === 3) {
        const paletteIndex = row[sourceOffset]!;
        const paletteOffset = paletteIndex * 3;
        if (!palette || paletteOffset + 2 >= palette.length) throw new Error('PNG 调色板无效');
        rgba.set(
          [
            palette[paletteOffset]!,
            palette[paletteOffset + 1]!,
            palette[paletteOffset + 2]!,
            transparency?.[paletteIndex] ?? 255,
          ],
          targetOffset,
        );
      } else if (colorType === 4) {
        const gray = row[sourceOffset]!;
        rgba.set([gray, gray, gray, row[sourceOffset + 1]!], targetOffset);
      } else {
        rgba.set(row.subarray(sourceOffset, sourceOffset + 4), targetOffset);
      }
    }
  }
  return { width, height, rgba };
}

/** 计算 PNG chunk 使用的 IEEE CRC-32。 */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** 构造带长度与 CRC 的 PNG chunk。 */
function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const output = new Uint8Array(data.byteLength + 12);
  const view = new DataView(output.buffer);
  view.setUint32(0, data.byteLength, false);
  output.set(typeBytes, 4);
  output.set(data, 8);
  view.setUint32(data.byteLength + 8, crc32(concatBytes([typeBytes, data])), false);
  return output;
}

/** 把 RGBA 像素编码为无交错 8 位 PNG。 */
export async function encodeRgbaPng(
  width: number,
  height: number,
  rgba: Uint8Array,
): Promise<Uint8Array> {
  const raw = new Uint8Array(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), rowStart + 1);
  }
  const stream = new Blob([raw.slice().buffer as ArrayBuffer])
    .stream()
    .pipeThrough(new CompressionStream('deflate'));
  const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, width, false);
  headerView.setUint32(4, height, false);
  header.set([8, 6, 0, 0, 0], 8);
  return concatBytes([
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', new Uint8Array()),
  ]);
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
 * 把主体置信度蒙版写入源图 Alpha 通道，生成真正带透明像素的 PNG。
 *
 * 火山视觉的实体分割返回灰度主体图层，而不是可直接作为最终资产使用的透明图片。这里在
 * Edge 内完成合成：黑色表示背景、白色表示主体，中间灰度保留发丝等半透明边缘。若蒙版
 * 尺寸与源图不一致，会先使用双线性缩放对齐源像素，避免因服务端预处理尺寸变化错位。
 *
 * @param sourceBytes - PNG/JPEG 等 imagescript 可解码的源图字节
 * @param maskBytes - 单通道或 RGB 灰度主体蒙版字节
 * @returns RGBA PNG 字节与自然尺寸
 */
export async function applyAlphaMask(
  sourceBytes: Uint8Array,
  maskBytes: Uint8Array,
): Promise<TransparentPngResult> {
  const source = await decodePng(sourceBytes);
  const mask = await decodePng(maskBytes);
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const offset = (y * source.width + x) * 4;
      // 双线性缩放不是必要前提，但可兼容服务端为性能返回较小主体图层的情况。
      const maskX = source.width === 1 ? 0 : (x * (mask.width - 1)) / (source.width - 1);
      const maskY = source.height === 1 ? 0 : (y * (mask.height - 1)) / (source.height - 1);
      const left = Math.floor(maskX);
      const top = Math.floor(maskY);
      const right = Math.min(mask.width - 1, left + 1);
      const bottom = Math.min(mask.height - 1, top + 1);
      const xWeight = maskX - left;
      const yWeight = maskY - top;
      const confidenceAt = (sampleX: number, sampleY: number): number => {
        const sampleOffset = (sampleY * mask.width + sampleX) * 4;
        return (
          ((mask.rgba[sampleOffset]! +
            mask.rgba[sampleOffset + 1]! +
            mask.rgba[sampleOffset + 2]!) /
            3) *
          (mask.rgba[sampleOffset + 3]! / 255)
        );
      };
      const topConfidence = confidenceAt(left, top) * (1 - xWeight) +
        confidenceAt(right, top) * xWeight;
      const bottomConfidence = confidenceAt(left, bottom) * (1 - xWeight) +
        confidenceAt(right, bottom) * xWeight;
      const confidence = Math.round(
        topConfidence * (1 - yWeight) + bottomConfidence * yWeight,
      );
      // 源图若本身含 Alpha，只能进一步变透明，不能恢复已透明像素。
      source.rgba[offset + 3] = Math.min(source.rgba[offset + 3]!, confidence);
    }
  }

  return {
    bytes: await encodeRgbaPng(source.width, source.height, source.rgba),
    width: source.width,
    height: source.height,
  };
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
