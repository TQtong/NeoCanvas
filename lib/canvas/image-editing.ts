/**
 * 精准图片编辑的纯计算核心。
 *
 * 本模块只处理坐标、扩图几何与蒙版命令历史，不访问 DOM、React 或状态库。编辑器预览、
 * 图片渲染器和候选占位必须复用这里的算法，避免同一操作在不同层得到不同结果。
 *
 * @module lib/canvas/image-editing
 */

import type { AspectRatio, OutputCanvas } from '@/types';

/** 源像素或预览坐标中的二维点。 */
export interface ImageEditPoint {
  /** 横坐标。 */
  x: number;
  /** 纵坐标。 */
  y: number;
  /** Pointer Event 压感；无压感设备为 1。 */
  pressure: number;
}

/** 源图在编辑区域中的等比预览变换。 */
export interface ImagePreviewTransform {
  /** 预览图左上角相对编辑区域的 X。 */
  offsetX: number;
  /** 预览图左上角相对编辑区域的 Y。 */
  offsetY: number;
  /** 源像素到 CSS 预览像素的缩放系数。 */
  scale: number;
  /** 预览图 CSS 宽度。 */
  displayWidth: number;
  /** 预览图 CSS 高度。 */
  displayHeight: number;
  /** 源输入像素宽度。 */
  sourceWidth: number;
  /** 源输入像素高度。 */
  sourceHeight: number;
}

/** 扩图的四边新增像素。 */
export interface OutpaintInsets {
  /** 上边新增像素。 */
  top: number;
  /** 右边新增像素。 */
  right: number;
  /** 下边新增像素。 */
  bottom: number;
  /** 左边新增像素。 */
  left: number;
}

/** 候选节点的 flow 几何。 */
export interface CandidateGeometry {
  /** 左上角 X。 */
  x: number;
  /** 左上角 Y。 */
  y: number;
  /** 节点宽度。 */
  width: number;
  /** 节点高度。 */
  height: number;
}

/** 蒙版工具。 */
export type MaskTool = 'brush' | 'eraser';

/** 一条以源图片像素记录的蒙版笔画。 */
export interface MaskStroke {
  /** 稳定标识，用于 React 列表及调试追踪。 */
  id: string;
  /** 画笔写入白色，橡皮写入黑色。 */
  tool: MaskTool;
  /** 笔刷直径，单位为源像素。 */
  sizePx: number;
  /** 采样点；至少一个点。 */
  points: ImageEditPoint[];
}

/** 蒙版历史命令；清空作为命令参与撤销和重做。 */
export type MaskCommand = { type: 'stroke'; stroke: MaskStroke } | { type: 'clear'; id: string };

/**
 * 蒙版历史。
 *
 * `baseMask` 是已压平的历史前缀 PNG。`commands[0..cursor)` 是当前有效的可撤销尾部，
 * `commands[cursor..]` 是重做分支。达到上限时，渲染器把较早命令合入 `baseMask`，所以不会
 * 丢失像素结果，也不会无限保留笔画对象。
 */
export interface MaskHistory {
  /** 已压平前缀的黑底白区 PNG；尚未压平时为 null。 */
  baseMask: Blob | null;
  /** 基础蒙版累计包含的命令数，仅用于审计与调试。 */
  compactedCommandCount: number;
  /** 当前仍可撤销/重做的尾部命令。 */
  commands: MaskCommand[];
  /** 当前有效命令数。 */
  cursor: number;
}

/** 历史压平计划。 */
export interface MaskCompactionPlan {
  /** 需顺序合入基础蒙版的命令。 */
  commandsToCompact: MaskCommand[];
  /** 压平完成后继续保留的历史。 */
  remainingHistory: MaskHistory;
}

/** 蒙版可撤销历史的硬上限。 */
export const MASK_HISTORY_LIMIT = 200;
/** 超限时一次压平的命令数，留出余量避免每画一笔都重新编码 PNG。 */
export const MASK_HISTORY_COMPACTION_BATCH = 50;

/** 把数值钳制到闭区间。 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 要求输入是有限正数。 */
function assertPositiveFinite(value: number, field: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${field} 必须是有限正数`);
  }
}

/** 要求输入是有限非负数。 */
function assertNonNegativeFinite(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${field} 必须是有限非负数`);
  }
}

/**
 * 计算源图在编辑区域中完整可见、居中的等比预览矩阵。
 */
export function computeImagePreviewTransform(
  sourceWidth: number,
  sourceHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  padding = 0,
): ImagePreviewTransform {
  assertPositiveFinite(sourceWidth, 'sourceWidth');
  assertPositiveFinite(sourceHeight, 'sourceHeight');
  assertPositiveFinite(viewportWidth, 'viewportWidth');
  assertPositiveFinite(viewportHeight, 'viewportHeight');
  assertNonNegativeFinite(padding, 'padding');

  const availableWidth = viewportWidth - padding * 2;
  const availableHeight = viewportHeight - padding * 2;
  assertPositiveFinite(availableWidth, '可用预览宽度');
  assertPositiveFinite(availableHeight, '可用预览高度');

  const scale = Math.min(availableWidth / sourceWidth, availableHeight / sourceHeight);
  const displayWidth = sourceWidth * scale;
  const displayHeight = sourceHeight * scale;
  return {
    offsetX: (viewportWidth - displayWidth) / 2,
    offsetY: (viewportHeight - displayHeight) / 2,
    scale,
    displayWidth,
    displayHeight,
    sourceWidth,
    sourceHeight,
  };
}

/**
 * 把编辑区域中的 CSS 预览点转换为源像素点。
 *
 * 点位会钳制到图片边界，确保 Pointer 捕获期间移出预览也不会写入非法坐标。DPR 不参与
 * 运算，因为保存坐标只由 CSS 预览矩阵和源像素决定。
 */
export function previewPointToSource(
  point: Pick<ImageEditPoint, 'x' | 'y'>,
  transform: ImagePreviewTransform,
  pressure = 1,
): ImageEditPoint {
  assertPositiveFinite(transform.scale, 'transform.scale');
  return {
    x: clamp((point.x - transform.offsetX) / transform.scale, 0, transform.sourceWidth),
    y: clamp((point.y - transform.offsetY) / transform.scale, 0, transform.sourceHeight),
    pressure: clamp(Number.isFinite(pressure) && pressure > 0 ? pressure : 1, 0.01, 1),
  };
}

/** 把源像素点转换回 CSS 预览点。 */
export function sourcePointToPreview(
  point: Pick<ImageEditPoint, 'x' | 'y'>,
  transform: ImagePreviewTransform,
): Pick<ImageEditPoint, 'x' | 'y'> {
  assertPositiveFinite(transform.scale, 'transform.scale');
  return {
    x: transform.offsetX + point.x * transform.scale,
    y: transform.offsetY + point.y * transform.scale,
  };
}

/**
 * 由四边扩展量构造服务端契约使用的输出画布。
 */
export function outputCanvasFromInsets(
  sourceWidth: number,
  sourceHeight: number,
  insets: OutpaintInsets,
): OutputCanvas {
  assertPositiveFinite(sourceWidth, 'sourceWidth');
  assertPositiveFinite(sourceHeight, 'sourceHeight');
  for (const [key, value] of Object.entries(insets)) {
    assertNonNegativeFinite(value, `insets.${key}`);
  }

  const left = Math.round(insets.left);
  const right = Math.round(insets.right);
  const top = Math.round(insets.top);
  const bottom = Math.round(insets.bottom);
  const width = Math.round(sourceWidth) + left + right;
  const height = Math.round(sourceHeight) + top + bottom;
  return {
    width,
    height,
    sourceX: left,
    sourceY: top,
    sourceWidth: Math.round(sourceWidth),
    sourceHeight: Math.round(sourceHeight),
  };
}

/** 解析 `16:9` 一类比例字面量。 */
export function aspectRatioValue(aspectRatio: AspectRatio): number {
  const [width = Number.NaN, height = Number.NaN] = aspectRatio.split(':').map(Number);
  assertPositiveFinite(width, '比例宽');
  assertPositiveFinite(height, '比例高');
  return width / height;
}

/**
 * 以源图中心为锚点，生成指定比例下能够完整容纳源图的最小整数像素画布。
 */
export function outputCanvasForAspectRatio(
  sourceWidth: number,
  sourceHeight: number,
  aspectRatio: AspectRatio,
): OutputCanvas {
  assertPositiveFinite(sourceWidth, 'sourceWidth');
  assertPositiveFinite(sourceHeight, 'sourceHeight');
  const sourceW = Math.round(sourceWidth);
  const sourceH = Math.round(sourceHeight);
  const targetRatio = aspectRatioValue(aspectRatio);
  const sourceRatio = sourceW / sourceH;

  let width = sourceW;
  let height = sourceH;
  if (sourceRatio > targetRatio) height = Math.ceil(sourceW / targetRatio);
  else if (sourceRatio < targetRatio) width = Math.ceil(sourceH * targetRatio);

  return {
    width,
    height,
    sourceX: Math.floor((width - sourceW) / 2),
    sourceY: Math.floor((height - sourceH) / 2),
    sourceWidth: sourceW,
    sourceHeight: sourceH,
  };
}

/** 验证输出画布是否以非负整数完整包含源图。 */
export function isValidOutputCanvas(canvas: OutputCanvas): boolean {
  const values = [
    canvas.width,
    canvas.height,
    canvas.sourceX,
    canvas.sourceY,
    canvas.sourceWidth,
    canvas.sourceHeight,
  ];
  return (
    values.every(Number.isInteger) &&
    canvas.width > 0 &&
    canvas.height > 0 &&
    canvas.sourceWidth > 0 &&
    canvas.sourceHeight > 0 &&
    canvas.sourceX >= 0 &&
    canvas.sourceY >= 0 &&
    canvas.sourceX + canvas.sourceWidth <= canvas.width &&
    canvas.sourceY + canvas.sourceHeight <= canvas.height
  );
}

/** 把输出画布还原成四边扩展量，便于比例预设与自由拖动互相切换。 */
export function outputCanvasToInsets(canvas: OutputCanvas): OutpaintInsets {
  if (!isValidOutputCanvas(canvas)) throw new RangeError('outputCanvas 无法完整容纳源图');
  return {
    top: canvas.sourceY,
    right: canvas.width - canvas.sourceX - canvas.sourceWidth,
    bottom: canvas.height - canvas.sourceY - canvas.sourceHeight,
    left: canvas.sourceX,
  };
}

/**
 * 当源输入按 Provider 上限等比降采样时，同步缩放扩图像素画布。
 */
export function scaleOutputCanvas(canvas: OutputCanvas, scale: number): OutputCanvas {
  if (!isValidOutputCanvas(canvas)) throw new RangeError('outputCanvas 无法完整容纳源图');
  if (!Number.isFinite(scale) || scale <= 0) throw new RangeError('scale 必须是有限正数');
  const sourceWidth = Math.max(1, Math.round(canvas.sourceWidth * scale));
  const sourceHeight = Math.max(1, Math.round(canvas.sourceHeight * scale));
  const sourceX = Math.max(0, Math.round(canvas.sourceX * scale));
  const sourceY = Math.max(0, Math.round(canvas.sourceY * scale));
  const right = Math.max(
    0,
    Math.round((canvas.width - canvas.sourceX - canvas.sourceWidth) * scale),
  );
  const bottom = Math.max(
    0,
    Math.round((canvas.height - canvas.sourceY - canvas.sourceHeight) * scale),
  );
  return {
    width: sourceX + sourceWidth + right,
    height: sourceY + sourceHeight + bottom,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
  };
}

/**
 * 计算扩图候选的节点几何。
 *
 * 按产品契约保持主节点中心与原面积，以输出像素比例重新分配宽高。这样横竖比例切换不会
 * 因固定某一条边而突然放大或缩小，且客户端占位与采用事务能够稳定复算。
 */
export function candidateGeometryForOutput(
  sourceGeometry: CandidateGeometry,
  outputCanvas: OutputCanvas,
): CandidateGeometry {
  assertPositiveFinite(sourceGeometry.width, 'sourceGeometry.width');
  assertPositiveFinite(sourceGeometry.height, 'sourceGeometry.height');
  if (!isValidOutputCanvas(outputCanvas)) throw new RangeError('outputCanvas 无法完整容纳源图');

  const area = sourceGeometry.width * sourceGeometry.height;
  const ratio = outputCanvas.width / outputCanvas.height;
  const width = Math.sqrt(area * ratio);
  const height = Math.sqrt(area / ratio);
  const centerX = sourceGeometry.x + sourceGeometry.width / 2;
  const centerY = sourceGeometry.y + sourceGeometry.height / 2;
  return {
    x: centerX - width / 2,
    y: centerY - height / 2,
    width,
    height,
  };
}

/** 创建空蒙版历史。 */
export function createMaskHistory(): MaskHistory {
  return {
    baseMask: null,
    compactedCommandCount: 0,
    commands: [],
    cursor: 0,
  };
}

/** 向历史追加命令；追加时截断尚未重做的旧分支。 */
export function appendMaskCommand(history: MaskHistory, command: MaskCommand): MaskHistory {
  const active = history.commands.slice(0, history.cursor);
  return {
    ...history,
    commands: [...active, command],
    cursor: active.length + 1,
  };
}

/** 撤销一条尾部命令。 */
export function undoMaskCommand(history: MaskHistory): MaskHistory {
  return { ...history, cursor: Math.max(0, history.cursor - 1) };
}

/** 重做一条尾部命令。 */
export function redoMaskCommand(history: MaskHistory): MaskHistory {
  return { ...history, cursor: Math.min(history.commands.length, history.cursor + 1) };
}

/** 返回当前有效命令，不暴露重做分支。 */
export function activeMaskCommands(history: MaskHistory): MaskCommand[] {
  return history.commands.slice(0, history.cursor);
}

/** 历史是否包含会改变蒙版像素的有效命令或已压平前缀。 */
export function hasMaskContent(history: MaskHistory): boolean {
  let hasStroke = Boolean(history.baseMask);
  for (const command of activeMaskCommands(history)) {
    if (command.type === 'clear') hasStroke = false;
    else hasStroke = true;
  }
  return hasStroke;
}

/**
 * 为超限历史制定压平计划。
 *
 * 只有当前游标位于历史末尾时才压平，避免把可重做分支错误合入基础位图。调用方把
 * `commandsToCompact` 栅格化到 `baseMask` 后，再通过 {@link completeMaskCompaction} 回填。
 */
export function planMaskCompaction(history: MaskHistory): MaskCompactionPlan | null {
  if (history.cursor !== history.commands.length || history.commands.length <= MASK_HISTORY_LIMIT) {
    return null;
  }
  const count = Math.min(
    MASK_HISTORY_COMPACTION_BATCH,
    history.commands.length - MASK_HISTORY_LIMIT + MASK_HISTORY_COMPACTION_BATCH,
  );
  return {
    commandsToCompact: history.commands.slice(0, count),
    remainingHistory: {
      ...history,
      commands: history.commands.slice(count),
      cursor: history.cursor - count,
    },
  };
}

/** 把新基础 PNG 写回压平计划，得到可继续编辑的历史。 */
export function completeMaskCompaction(plan: MaskCompactionPlan, baseMask: Blob): MaskHistory {
  if (baseMask.type !== 'image/png') throw new TypeError('基础蒙版必须是 PNG');
  return {
    ...plan.remainingHistory,
    baseMask,
    compactedCommandCount:
      plan.remainingHistory.compactedCommandCount + plan.commandsToCompact.length,
  };
}
