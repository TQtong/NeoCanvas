/**
 * 精准图片编辑的浏览器栅格渲染器。
 *
 * 负责蒙版重放、历史压平、羽化和按模型像素上限多阶段降采样。这里生成的标准蒙版始终
 * 是不透明黑底白区 PNG；Provider 若要求 Alpha 通道，必须在服务端适配器中转换。
 *
 * @module lib/canvas/image-edit-renderer
 */

import {
  completeMaskCompaction,
  planMaskCompaction,
  type MaskCommand,
  type MaskCompactionPlan,
  type MaskHistory,
  type MaskStroke,
} from './image-editing';

/** 解码后的可绘制图片及显式释放函数。 */
interface DecodedImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  close: () => void;
}

/** 降采样后的文件和真实像素信息。 */
export interface ResampledImage {
  /** 可直接上传的文件。 */
  file: File;
  /** 输出像素宽。 */
  width: number;
  /** 输出像素高。 */
  height: number;
  /** 是否实际发生降采样。 */
  resized: boolean;
}

/** 蒙版提交编码；亮度蒙版用于 fal/Jimeng，Alpha 蒙版用于 OpenAI edits。 */
export type MaskEncoding = 'luminance' | 'openai-alpha';

/** 受像素和单边上限约束的图片尺寸。 */
export interface ConstrainedImageSize {
  /** 目标像素宽。 */
  width: number;
  /** 目标像素高。 */
  height: number;
  /** 相对原图的统一缩放系数。 */
  scale: number;
}

/** 创建确定尺寸的 2D Canvas，并启用高质量缩放。 */
function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法创建 2D 画布上下文');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  return canvas;
}

/** 取 Canvas 2D 上下文，并保留明确的错误阶段。 */
function getContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法创建 2D 画布上下文');
  return context;
}

/** Canvas 异步编码为 Blob。 */
async function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality?: number,
): Promise<Blob> {
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('浏览器无法编码编辑图片'))),
      type,
      quality,
    );
  });
}

/** 使用 ImageBitmap 优先解码，旧浏览器回退 HTMLImageElement。 */
async function decodeBlob(blob: Blob, signal?: AbortSignal): Promise<DecodedImage> {
  signal?.throwIfAborted();
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob);
    signal?.throwIfAborted();
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      close: () => bitmap.close(),
    };
  }

  const objectUrl = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.decoding = 'async';
    image.src = objectUrl;
    await image.decode();
    signal?.throwIfAborted();
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      close: () => URL.revokeObjectURL(objectUrl),
    };
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

/** 在黑色蒙版上重放单笔画；按相邻点平均压感调整线宽。 */
function drawStroke(context: CanvasRenderingContext2D, stroke: MaskStroke): void {
  const points = stroke.points;
  if (points.length === 0) return;
  context.save();
  context.globalCompositeOperation = 'source-over';
  context.strokeStyle = stroke.tool === 'brush' ? '#ffffff' : '#000000';
  context.fillStyle = context.strokeStyle;
  context.lineCap = 'round';
  context.lineJoin = 'round';

  if (points.length === 1) {
    const point = points[0]!;
    context.beginPath();
    context.arc(
      point.x,
      point.y,
      Math.max(0.5, (stroke.sizePx * point.pressure) / 2),
      0,
      Math.PI * 2,
    );
    context.fill();
    context.restore();
    return;
  }

  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]!;
    const current = points[index]!;
    context.lineWidth = Math.max(1, stroke.sizePx * ((previous.pressure + current.pressure) / 2));
    context.beginPath();
    context.moveTo(previous.x, previous.y);
    context.lineTo(current.x, current.y);
    context.stroke();
  }
  context.restore();
}

/** 顺序重放一组蒙版命令。 */
function replayMaskCommands(
  context: CanvasRenderingContext2D,
  commands: MaskCommand[],
  width: number,
  height: number,
): void {
  for (const command of commands) {
    if (command.type === 'clear') {
      context.save();
      context.globalCompositeOperation = 'source-over';
      context.fillStyle = '#000000';
      context.fillRect(0, 0, width, height);
      context.restore();
    } else {
      drawStroke(context, command.stroke);
    }
  }
}

/** 把基础蒙版解码并铺到目标像素画布。 */
async function drawBaseMask(
  context: CanvasRenderingContext2D,
  baseMask: Blob,
  width: number,
  height: number,
  signal?: AbortSignal,
): Promise<void> {
  const decoded = await decodeBlob(baseMask, signal);
  try {
    // 历史压平后的基础蒙版可能来自原始分辨率；目标降采样时在此同步缩放，再重放缩放笔画。
    context.drawImage(decoded.source, 0, 0, width, height);
  } finally {
    decoded.close();
  }
}

/**
 * 将蒙版历史映射到新的栅格尺寸。笔画坐标与画笔直径一起缩放，基础蒙版由渲染阶段缩放；
 * 羽化不在这里处理，调用方必须用目标像素重新计算羽化半径。
 */
export function scaleMaskHistoryForRaster(
  history: MaskHistory,
  scaleX: number,
  scaleY: number,
): MaskHistory {
  if (!(scaleX > 0) || !(scaleY > 0)) throw new RangeError('蒙版缩放比例必须大于 0');
  const brushScale = (scaleX + scaleY) / 2;
  const commands = history.commands.map((command): MaskCommand => {
    if (command.type === 'clear') return command;
    return {
      type: 'stroke',
      stroke: {
        ...command.stroke,
        sizePx: command.stroke.sizePx * brushScale,
        points: command.stroke.points.map((point) => ({
          ...point,
          x: point.x * scaleX,
          y: point.y * scaleY,
        })),
      },
    };
  });
  return { ...history, commands };
}

/**
 * 栅格化蒙版历史。
 *
 * 羽化先以 Canvas 高斯滤镜产生连续边缘，再用未羽化蒙版恢复远离边缘的纯黑/纯白区域，
 * 保证输出中心和外部不是近似灰色。
 */
export async function renderMaskBlob(
  history: MaskHistory,
  width: number,
  height: number,
  featherPx: number,
  signal?: AbortSignal,
  encoding: MaskEncoding = 'luminance',
): Promise<Blob> {
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new RangeError('蒙版尺寸必须是正整数');
  }
  if (!Number.isFinite(featherPx) || featherPx < 0 || featherPx > 128) {
    throw new RangeError('蒙版羽化必须位于 0..128 像素');
  }
  signal?.throwIfAborted();

  const raw = createCanvas(width, height);
  const rawContext = getContext(raw);
  rawContext.fillStyle = '#000000';
  rawContext.fillRect(0, 0, width, height);
  if (history.baseMask) {
    await drawBaseMask(rawContext, history.baseMask, width, height, signal);
  }
  replayMaskCommands(rawContext, history.commands.slice(0, history.cursor), width, height);
  signal?.throwIfAborted();

  if (featherPx === 0) {
    if (encoding === 'openai-alpha') applyOpenAIAlphaMask(rawContext, width, height);
    return await canvasToBlob(raw, 'image/png');
  }

  const feathered = createCanvas(width, height);
  const featheredContext = getContext(feathered);
  featheredContext.fillStyle = '#000000';
  featheredContext.fillRect(0, 0, width, height);
  featheredContext.filter = `blur(${featherPx}px)`;
  featheredContext.drawImage(raw, 0, 0);
  featheredContext.filter = 'none';

  // 仅在距边缘足够远的区域恢复二值，灰色羽化带保持连续。
  const rawPixels = rawContext.getImageData(0, 0, width, height);
  const outputPixels = featheredContext.getImageData(0, 0, width, height);
  for (let index = 0; index < outputPixels.data.length; index += 4) {
    const rawValue = rawPixels.data[index]!;
    const blurredValue = outputPixels.data[index]!;
    const restored =
      rawValue === 255 && blurredValue >= 250
        ? 255
        : rawValue === 0 && blurredValue <= 5
          ? 0
          : blurredValue;
    outputPixels.data[index] = restored;
    outputPixels.data[index + 1] = restored;
    outputPixels.data[index + 2] = restored;
    outputPixels.data[index + 3] = 255;
  }
  featheredContext.putImageData(outputPixels, 0, 0);
  if (encoding === 'openai-alpha') {
    applyOpenAIAlphaMask(featheredContext, width, height);
  }
  signal?.throwIfAborted();
  return await canvasToBlob(feathered, 'image/png');
}

/**
 * 把「白色编辑、黑色保留」的中性亮度蒙版转换为 OpenAI 所需 Alpha 语义。
 * OpenAI 在全透明区域执行编辑，因此 Alpha 必须取亮度反值；RGB 固定为白色避免预乘色污染。
 */
function applyOpenAIAlphaMask(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
): void {
  const pixels = context.getImageData(0, 0, width, height);
  convertLuminanceMaskToOpenAIAlpha(pixels.data);
  context.putImageData(pixels, 0, 0);
}

/**
 * 将 RGBA 亮度蒙版原地转换为 OpenAI Alpha 蒙版；导出纯函数供契约测试复用。
 */
export function convertLuminanceMaskToOpenAIAlpha(pixels: Uint8ClampedArray): void {
  if (pixels.length % 4 !== 0) throw new RangeError('蒙版像素数组必须是完整 RGBA 数据');
  for (let index = 0; index < pixels.length; index += 4) {
    const editWeight = pixels[index]!;
    pixels[index] = 255;
    pixels[index + 1] = 255;
    pixels[index + 2] = 255;
    pixels[index + 3] = 255 - editWeight;
  }
}

/** 生成可上传的标准蒙版 PNG 文件。 */
export async function renderMaskFile(
  history: MaskHistory,
  width: number,
  height: number,
  featherPx: number,
  signal?: AbortSignal,
  encoding: MaskEncoding = 'luminance',
): Promise<File> {
  const blob = await renderMaskBlob(history, width, height, featherPx, signal, encoding);
  return new File([blob], `mask-${width}x${height}.png`, { type: 'image/png' });
}

/**
 * 构造 OpenAI 扩图输入：输出画布保持透明，只在 outputCanvas 指定区域绘制源图。
 * 透明边界即模型需要补全的区域，源图像素不做二次拉伸。
 */
export async function renderOutpaintInputFile(
  source: File,
  outputCanvas: {
    width: number;
    height: number;
    sourceX: number;
    sourceY: number;
    sourceWidth: number;
    sourceHeight: number;
  },
  signal?: AbortSignal,
): Promise<File> {
  const values = Object.values(outputCanvas);
  const valid = values.every((value) => Number.isInteger(value) && value >= 0);
  const sourceFits =
    outputCanvas.width > 0 &&
    outputCanvas.height > 0 &&
    outputCanvas.sourceWidth > 0 &&
    outputCanvas.sourceHeight > 0 &&
    outputCanvas.sourceX + outputCanvas.sourceWidth <= outputCanvas.width &&
    outputCanvas.sourceY + outputCanvas.sourceHeight <= outputCanvas.height;
  if (!valid || !sourceFits) throw new RangeError('扩图输入画布参数无效');

  const decoded = await decodeBlob(source, signal);
  try {
    const canvas = createCanvas(outputCanvas.width, outputCanvas.height);
    const context = getContext(canvas);
    context.clearRect(0, 0, outputCanvas.width, outputCanvas.height);
    context.drawImage(
      decoded.source,
      0,
      0,
      decoded.width,
      decoded.height,
      outputCanvas.sourceX,
      outputCanvas.sourceY,
      outputCanvas.sourceWidth,
      outputCanvas.sourceHeight,
    );
    signal?.throwIfAborted();
    const blob = await canvasToBlob(canvas, 'image/png');
    return new File([blob], `outpaint-${outputCanvas.width}x${outputCanvas.height}.png`, {
      type: 'image/png',
    });
  } finally {
    decoded.close();
  }
}

/**
 * 执行一次蒙版历史压平。无压平需要时原样返回，调用方可在每次结束笔画后安全调用。
 */
export async function compactMaskHistory(
  history: MaskHistory,
  width: number,
  height: number,
  signal?: AbortSignal,
): Promise<MaskHistory> {
  const plan = planMaskCompaction(history);
  if (!plan) return history;
  const prefixHistory: MaskHistory = {
    baseMask: history.baseMask,
    compactedCommandCount: history.compactedCommandCount,
    commands: plan.commandsToCompact,
    cursor: plan.commandsToCompact.length,
  };
  const baseMask = await renderMaskBlob(prefixHistory, width, height, 0, signal);
  return completeMaskCompaction(plan, baseMask);
}

/**
 * 计算同时满足总像素与单边上限的等比尺寸。
 */
export function constrainImageSize(
  width: number,
  height: number,
  maxPixels: number,
  maxEdge = Number.POSITIVE_INFINITY,
): ConstrainedImageSize {
  for (const [field, value] of Object.entries({ width, height, maxPixels })) {
    if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${field} 必须是有限正数`);
  }
  if (!(maxEdge > 0)) throw new RangeError('maxEdge 必须大于 0');
  const scale = Math.min(
    1,
    Math.sqrt(maxPixels / (width * height)),
    maxEdge / width,
    maxEdge / height,
  );
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
    scale,
  };
}

/**
 * 按模型上限高质量降采样。
 *
 * 每一步最多缩小一半，避免浏览器从超大原图一次压到小图产生明显锯齿。原文件符合限制时
 * 直接返回，不进行重新编码；调用结束始终释放 ImageBitmap 或对象 URL。
 */
export async function resampleImageFile(
  file: File,
  maxPixels: number,
  maxEdge = Number.POSITIVE_INFINITY,
  signal?: AbortSignal,
): Promise<ResampledImage> {
  const decoded = await decodeBlob(file, signal);
  try {
    const target = constrainImageSize(decoded.width, decoded.height, maxPixels, maxEdge);
    if (target.scale === 1) {
      return { file, width: decoded.width, height: decoded.height, resized: false };
    }

    let currentWidth = decoded.width;
    let currentHeight = decoded.height;
    let currentCanvas = createCanvas(currentWidth, currentHeight);
    getContext(currentCanvas).drawImage(decoded.source, 0, 0, currentWidth, currentHeight);

    while (currentWidth > target.width || currentHeight > target.height) {
      signal?.throwIfAborted();
      const nextWidth = Math.max(target.width, Math.floor(currentWidth / 2));
      const nextHeight = Math.max(target.height, Math.floor(currentHeight / 2));
      const nextCanvas = createCanvas(nextWidth, nextHeight);
      getContext(nextCanvas).drawImage(
        currentCanvas,
        0,
        0,
        currentWidth,
        currentHeight,
        0,
        0,
        nextWidth,
        nextHeight,
      );
      // 断开旧 Canvas 的像素缓冲引用，让浏览器可在下一轮前回收大块内存。
      currentCanvas.width = 1;
      currentCanvas.height = 1;
      currentCanvas = nextCanvas;
      currentWidth = nextWidth;
      currentHeight = nextHeight;
    }

    const preservesTransparency = file.type === 'image/png' || file.type === 'image/webp';
    const outputType = preservesTransparency ? 'image/png' : 'image/jpeg';
    const blob = await canvasToBlob(
      currentCanvas,
      outputType,
      outputType === 'image/jpeg' ? 0.94 : undefined,
    );
    const extension = outputType === 'image/png' ? 'png' : 'jpg';
    const basename = file.name.replace(/\.[^.]+$/, '') || 'edit-input';
    return {
      file: new File([blob], `${basename}-${currentWidth}x${currentHeight}.${extension}`, {
        type: outputType,
      }),
      width: currentWidth,
      height: currentHeight,
      resized: true,
    };
  } finally {
    decoded.close();
  }
}

/** 仅供测试与定向调试：验证压平计划的基础形状。 */
export function maskCompactionPrefix(plan: MaskCompactionPlan): readonly MaskCommand[] {
  return plan.commandsToCompact;
}
