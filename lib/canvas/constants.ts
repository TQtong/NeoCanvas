/**
 * 画布常量与默认节点数据工厂。
 *
 * 集中维护缩放区间、最小尺寸、吸附阈值、默认视口，以及各类型节点的默认尺寸与默认
 * `data`。新建节点（工具创建、粘贴、生成占位）统一经此取得一致的初值。
 *
 * @module lib/canvas/constants
 */

import type {
  DrawingNodeData,
  FrameNodeData,
  GenerationPlaceholderNodeData,
  ImageFilters,
  ImageNodeData,
  NodeData,
  NodeDataOf,
  NodeType,
  ShapeNodeData,
  TextNodeData,
  VideoNodeData,
  Viewport,
} from '@/types';

/** 缩放下限。 */
export const ZOOM_MIN = 0.1;
/** 缩放上限。 */
export const ZOOM_MAX = 4;
/** 缩放步进（每次滚轮 / 按钮）。 */
export const ZOOM_STEP = 0.2;
/** fitView 的内边距比例。 */
export const FIT_VIEW_PADDING = 0.2;

/** 节点最小宽（flow px）。 */
export const MIN_NODE_WIDTH = 24;
/** 节点最小高（flow px）。 */
export const MIN_NODE_HEIGHT = 24;

/** 对齐吸附阈值（屏幕像素，比较时换算到 flow）。 */
export const SNAP_THRESHOLD = 6;

/** 复制粘贴时新节点的偏移（flow px）。 */
export const PASTE_OFFSET = 24;

/** 默认视口：原点、1 倍缩放。 */
export const DEFAULT_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 };

/** 预设缩放倍率（左下角缩放控件展开）。 */
export const ZOOM_PRESETS = [0.25, 0.5, 1, 1.5, 2, 4] as const;

/** 各类型节点的默认尺寸（flow px）。 */
export const DEFAULT_NODE_SIZE: Record<NodeType, { width: number; height: number }> = {
  image: { width: 320, height: 320 },
  text: { width: 240, height: 64 },
  shape: { width: 160, height: 120 },
  drawing: { width: 200, height: 200 },
  video: { width: 480, height: 270 },
  generation_placeholder: { width: 320, height: 320 },
  frame: { width: 800, height: 600 },
};

/** 默认图片滤镜（无任何调整）。 */
export const DEFAULT_IMAGE_FILTERS: ImageFilters = {
  brightness: 1,
  contrast: 1,
  saturation: 1,
  grayscale: 0,
  sepia: 0,
  blur: 0,
  hueRotate: 0,
};

/** 默认文本字体族（中英混排）。 */
export const DEFAULT_FONT_FAMILY =
  'var(--font-sans), -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';

const defaultImageData = (): ImageNodeData => ({
  type: 'image',
  rotation: 0,
  assetId: null,
  naturalWidth: null,
  naturalHeight: null,
  crop: null,
  filters: { ...DEFAULT_IMAGE_FILTERS },
  opacity: 1,
  cornerRadius: 8,
  objectFit: 'cover',
  alt: '',
});

const defaultTextData = (): TextNodeData => ({
  type: 'text',
  rotation: 0,
  text: '',
  fontFamily: DEFAULT_FONT_FAMILY,
  fontSize: 24,
  fontWeight: 500,
  lineHeight: 1.35,
  letterSpacing: 0,
  align: 'left',
  color: 'hsl(240 10% 12%)',
  autoWrap: true,
  italic: false,
  underline: false,
  backgroundColor: 'transparent',
});

const defaultShapeData = (): ShapeNodeData => ({
  type: 'shape',
  rotation: 0,
  shape: 'rectangle',
  fill: 'hsl(262 83% 60% / 0.12)',
  stroke: 'hsl(262 83% 60%)',
  strokeWidth: 2,
  cornerRadius: 12,
  strokeStyle: 'solid',
  opacity: 1,
});

const defaultDrawingData = (): DrawingNodeData => ({
  type: 'drawing',
  rotation: 0,
  points: [],
  path: '',
  stroke: 'hsl(240 10% 12%)',
  strokeWidth: 3,
  smoothing: 0.5,
  opacity: 1,
});

const defaultVideoData = (): VideoNodeData => ({
  type: 'video',
  rotation: 0,
  assetId: null,
  posterAssetId: null,
  autoplay: false,
  muted: true,
  loop: false,
  trimStartMs: 0,
  trimEndMs: null,
  cornerRadius: 8,
});

const defaultPlaceholderData = (): GenerationPlaceholderNodeData => ({
  type: 'generation_placeholder',
  rotation: 0,
  generationId: null,
  targetModality: 'image',
  promptSummary: '',
  targetWidth: DEFAULT_NODE_SIZE.generation_placeholder.width,
  targetHeight: DEFAULT_NODE_SIZE.generation_placeholder.height,
  progress: 0,
});

const defaultFrameData = (): FrameNodeData => ({
  type: 'frame',
  rotation: 0,
  name: '画板',
  preset: 'custom',
  background: 'hsl(0 0% 100%)',
  showGrid: true,
});

/** 默认 data 工厂表，按类型取对应工厂。 */
const DEFAULT_DATA_FACTORIES: { [K in NodeType]: () => NodeDataOf<K> } = {
  image: defaultImageData,
  text: defaultTextData,
  shape: defaultShapeData,
  drawing: defaultDrawingData,
  video: defaultVideoData,
  generation_placeholder: defaultPlaceholderData,
  frame: defaultFrameData,
};

/**
 * 创建某类型节点的默认 `data`，可用 overrides 覆盖部分字段。
 *
 * @typeParam T - 节点类型
 * @param type - 节点类型
 * @param overrides - 覆盖字段
 * @returns 该类型的完整默认 data
 */
export function createDefaultNodeData<T extends NodeType>(
  type: T,
  overrides?: Partial<NodeDataOf<T>>,
): NodeDataOf<T> {
  const base = DEFAULT_DATA_FACTORIES[type]();
  return { ...base, ...overrides } as NodeDataOf<T>;
}

/** 联合形态的便捷工厂（运行时按 type 取默认 data）。 */
export function createDefaultNodeDataUnion(type: NodeType): NodeData {
  return DEFAULT_DATA_FACTORIES[type]() as NodeData;
}
