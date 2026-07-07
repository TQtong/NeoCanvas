/**
 * 画布节点数据契约。
 *
 * 这是数据面映射（`canvas_nodes` 行）与画布渲染（React Flow 节点）共同依赖的判别
 * 联合，以 `type` 为判别标签（与 {@link NodeType} 枚举一一对应）。
 *
 * 设计要点（见第 03 篇第七节、第 04 篇 4.4、第 06 篇第七节）：
 * - 通用几何与层级信息（position / width / height / z_index / parent）已在
 *   `canvas_nodes` 提为独立列，不进入本判别联合。
 * - `rotation`（来自 `canvas_nodes.rotation` 列）、`assetId`（来自 `asset_id` 列）、
 *   `generationId`（来自 `generation_id` 列）在映射时并入节点 `data`，因 React Flow
 *   节点无这些原生字段；它们是「列 ↔ data」的桥接字段。
 * - 标注「运行时」的字段（如 `src` 签名 URL、占位进度）不持久化到 `data` JSONB，
 *   由映射器在加载 / 回流时注入，详见 `lib/canvas/node-mapper`。
 *
 * 注意：各节点数据以 `type` 别名（而非 interface）声明，以获得隐式索引签名，从而
 * 满足 React Flow `Node<T extends Record<string, unknown>>` 的约束。
 *
 * @module types/nodes
 */

import type { BackgroundVariant, NodeType, ShapeKind, TextAlign } from './enums';
import type { AspectRatio, GenerationResultMode, ImageQuality } from './generation';

/**
 * 裁剪框，单位为原始媒体像素，描述从原图截取的矩形区域。
 */
export interface CropRect {
  /** 左上角 X（原图像素） */
  x: number;
  /** 左上角 Y（原图像素） */
  y: number;
  /** 裁剪宽（原图像素） */
  width: number;
  /** 裁剪高（原图像素） */
  height: number;
}

/**
 * 图片滤镜参数，映射为 CSS filter 函数链。取值区间见各字段说明。
 */
export interface ImageFilters {
  /** 亮度，1 为原始，区间 [0, 2] */
  brightness: number;
  /** 对比度，1 为原始，区间 [0, 2] */
  contrast: number;
  /** 饱和度，1 为原始，区间 [0, 2] */
  saturation: number;
  /** 灰度，0..1 */
  grayscale: number;
  /** 棕褐，0..1 */
  sepia: number;
  /** 模糊，单位 px，>= 0 */
  blur: number;
  /** 色相旋转，单位度，[-180, 180] */
  hueRotate: number;
}

/**
 * 手绘路径上的一个采样点（flow 局部坐标，相对节点左上角）。
 */
export interface DrawingPoint {
  /** 局部 X。 */
  x: number;
  /** 局部 Y。 */
  y: number;
  /** 压感（0..1），无压感设备恒为 1。 */
  pressure: number;
}

/**
 * 所有节点 data 共有的桥接字段。
 */
export type NodeDataBase = {
  [key: string]: unknown;
  /** 节点类型判别标签，恒等于所属 `canvas_nodes.type` 列。 */
  type: NodeType;
  /** 旋转角（度），来自 `canvas_nodes.rotation` 列；由内容容器以 CSS 变换应用。 */
  rotation: number;
  /**
   * 所属逻辑组标识（PPT / Figma 式分组）。同一 `groupId` 的节点构成一个组：选中任一成员
   * 即整组选中、一起移动 / 缩放；不引入容器节点，也不依赖父子关系。解组即清除此标记。
   * 持久化于 `canvas_nodes.data` JSONB。
   */
  groupId?: string;
};

/** 媒体节点在画布生成工作流中的角色。 */
export type MediaRole = 'primary' | 'candidate';

/** 图片尺寸预设：按当前比例换算长边像素。 */
export type ImageSizePreset = '1k' | '2k' | '4k' | '8k' | 'custom';

/**
 * 媒体节点的默认生成配置。它属于图片/视频本身，而不是某条流程消息。
 */
export interface MediaGenerationSettings {
  /** 当前用于后续生成的模型 key。 */
  modelKey: string | null;
  /** 单次希望生成的候选数量；默认 1，提交时受模型能力上限约束。 */
  count: number;
  /** 输出比例。 */
  aspectRatio?: AspectRatio;
  /** 图片尺寸预设；自定义时使用 width / height。 */
  sizePreset?: ImageSizePreset;
  /** 显式输出宽度。 */
  width?: number;
  /** 显式输出高度。 */
  height?: number;
  /** 图片质量档。 */
  quality?: ImageQuality;
  /** 视频时长。 */
  durationSec?: number;
  /** 视频分辨率。 */
  resolution?: string;
  /** 视频帧率。 */
  fps?: number;
  /** 视频运动强度。 */
  motionStrength?: number;
}

/** 图片/视频节点共享的媒体工作流字段。 */
export interface MediaWorkflowFields {
  /** 图片/视频本身的内容描述；区别于消息里的流程描述。 */
  mediaDescription: string;
  /** 后续生成默认使用的参数。 */
  generationSettings: MediaGenerationSettings;
  /** 主媒体或候选媒体。 */
  mediaRole: MediaRole;
  /** 候选所属的主媒体节点 id。主媒体为 null。 */
  candidateOf: string | null;
  /** 候选在主媒体历史中的顺序。主媒体为 null。 */
  candidateIndex: number | null;
  /** 产生该媒体版本的生成任务 id。 */
  sourceGenerationId: string | null;
  /** 是否收起该主媒体的候选历史。候选节点自身忽略该字段。 */
  candidatesCollapsed: boolean;
}

/**
 * 图片节点数据。真实媒体经 `assetId` 关联 `assets`，运行时解析为签名 URL。
 */
export type ImageNodeData = NodeDataBase & {
  type: 'image';
  /** 关联资产标识（来自 `canvas_nodes.asset_id` 列），未绑定时为 null。 */
  assetId: string | null;
  /** 原始媒体像素宽，用于裁剪与等比计算。 */
  naturalWidth: number | null;
  /** 原始媒体像素高。 */
  naturalHeight: number | null;
  /** 裁剪框；null 表示不裁剪。 */
  crop: CropRect | null;
  /** 滤镜参数。 */
  filters: ImageFilters;
  /** 整体透明度，0..1。 */
  opacity: number;
  /** 圆角半径（px）。 */
  cornerRadius: number;
  /** 适配方式。 */
  objectFit: 'cover' | 'contain' | 'fill';
  /** 无障碍替代文本。 */
  alt: string;
  /** 运行时注入：原图签名 URL，不持久化。 */
  src?: string | null;
  /** 运行时注入：缩略图签名 URL，不持久化。 */
  thumbnailSrc?: string | null;
} & MediaWorkflowFields;

/**
 * 文本节点数据。直接驱动可就地编辑的文本框。
 */
export type TextNodeData = NodeDataBase & {
  type: 'text';
  /** 文本内容（纯文本，换行以 \n 表达）。 */
  text: string;
  /** 字体族。 */
  fontFamily: string;
  /** 字号（px）。 */
  fontSize: number;
  /** 字重，100..900。 */
  fontWeight: number;
  /** 行高倍数（相对字号）。 */
  lineHeight: number;
  /** 字间距（px）。 */
  letterSpacing: number;
  /** 水平对齐。 */
  align: TextAlign;
  /** 文本颜色（CSS 颜色串）。 */
  color: string;
  /** 是否自动换行（false 时随文本撑宽）。 */
  autoWrap: boolean;
  /** 是否斜体。 */
  italic: boolean;
  /** 是否下划线。 */
  underline: boolean;
  /** 背景色（CSS 颜色串或 'transparent'）。 */
  backgroundColor: string;
};

/**
 * 形状节点数据。以内联 SVG 渲染。
 */
export type ShapeNodeData = NodeDataBase & {
  type: 'shape';
  /** 形状种类。 */
  shape: ShapeKind;
  /** 填充色（CSS 颜色串或 'transparent'）。 */
  fill: string;
  /** 描边色。 */
  stroke: string;
  /** 描边宽度（px）。 */
  strokeWidth: number;
  /** 圆角半径（px，矩形适用）。 */
  cornerRadius: number;
  /** 描边样式。 */
  strokeStyle: 'solid' | 'dashed' | 'dotted';
  /** 整体透明度，0..1。 */
  opacity: number;
};

/**
 * 手绘节点数据。路径由手绘交互采样并平滑而来，以 SVG path 渲染。
 */
export type DrawingNodeData = NodeDataBase & {
  type: 'drawing';
  /** 归一化后的采样点序列（相对节点局部坐标）。 */
  points: DrawingPoint[];
  /** 预先计算并缓存的 SVG path d 串（平滑后），运行时可据 points 重算。 */
  path: string;
  /** 笔触颜色。 */
  stroke: string;
  /** 笔触宽度（px）。 */
  strokeWidth: number;
  /** 平滑系数，0（折线）..1（高度平滑）。 */
  smoothing: number;
  /** 整体透明度，0..1。 */
  opacity: number;
};

/**
 * 视频节点数据。真实媒体经 `assetId` 关联 `assets`。
 */
export type VideoNodeData = NodeDataBase & {
  type: 'video';
  /** 关联资产标识（来自 `canvas_nodes.asset_id` 列）。 */
  assetId: string | null;
  /** 封面帧资产标识或外部封面路径；null 时取首帧。 */
  posterAssetId: string | null;
  /** 是否自动播放。 */
  autoplay: boolean;
  /** 是否静音。 */
  muted: boolean;
  /** 是否循环。 */
  loop: boolean;
  /** 播放区间起点（毫秒）。 */
  trimStartMs: number;
  /** 播放区间终点（毫秒）；null 表示至结尾。 */
  trimEndMs: number | null;
  /** 圆角半径（px）。 */
  cornerRadius: number;
  /** 运行时注入：视频签名 URL，不持久化。 */
  src?: string | null;
  /** 运行时注入：封面签名 URL，不持久化。 */
  posterSrc?: string | null;
} & MediaWorkflowFields;

/**
 * 生成占位节点数据。任务完成后该节点被原地改写为 image / video 节点。
 */
export type GenerationPlaceholderNodeData = NodeDataBase & {
  type: 'generation_placeholder';
  /** 关联生成任务标识（来自 `canvas_nodes.generation_id` 列）。 */
  generationId: string | null;
  /** 目标模态（决定完成后转化为 image 还是 video 节点）。 */
  targetModality: 'image' | 'video';
  /** 展示用的提示词摘要。 */
  promptSummary: string;
  /** 目标宽度（px），用于占位卡片尺寸。 */
  targetWidth: number;
  /** 目标高度（px）。 */
  targetHeight: number;
  /** 运行时注入：当前进度 0..100，由 Realtime 推送的生成任务进度驱动。 */
  progress?: number;
  /** 运行时注入：当前任务状态展示用。 */
  statusLabel?: string;
  /** 运行时注入：失败原因（失败态展示与重试）。 */
  errorMessage?: string | null;
  /** 候选占位归属的主媒体节点。 */
  targetNodeId?: string | null;
  /** 占位完成后的落图语义。 */
  resultMode?: GenerationResultMode;
};

/**
 * 画板节点数据。固定尺寸边框容器，可作为其他节点的父容器与导出边界。
 */
export type FrameNodeData = NodeDataBase & {
  type: 'frame';
  /** 画板名。 */
  name: string;
  /** 尺寸预设标识（如 '1:1'、'16:9'、'a4'、'custom'）。 */
  preset: string;
  /** 背景色（CSS 颜色串或 'transparent'）。 */
  background: string;
  /** 是否在该画板内显示网格。 */
  showGrid: boolean;
};

/** 媒体侧卡节点：承载某个图片/视频目标的对话与生成配置。 */
export type MediaPanelNodeData = NodeDataBase & {
  type: 'media_panel';
  /** 被管理的主图片/视频节点 id。 */
  targetNodeId: string;
  /** 侧卡是否折叠。 */
  collapsed: boolean;
};

/**
 * 画布节点数据判别联合：所有节点类型 data 的并集，以 `type` narrow。
 * 既是 `canvas_nodes.data` 的映射目标，又是 React Flow 节点 `data` 的类型。
 */
export type NodeData =
  | ImageNodeData
  | TextNodeData
  | ShapeNodeData
  | DrawingNodeData
  | VideoNodeData
  | GenerationPlaceholderNodeData
  | MediaPanelNodeData
  | FrameNodeData;

/**
 * 按节点类型取出其 data 形状的工具类型。
 *
 * @example
 *   type T = NodeDataOf<'text'>; // => TextNodeData
 */
export type NodeDataOf<T extends NodeType> = Extract<NodeData, { type: T }>;

/**
 * 画布背景设置，持久化于 `projects.viewport` 之外，作为画布级偏好（随节点无关）。
 * 当前以 frame/网格工具就地切换，未来可提升为项目级设置。
 */
export interface CanvasBackgroundSettings {
  /** 背景网格样式。 */
  variant: BackgroundVariant;
  /** 网格间距（px，flow 坐标）。 */
  gap: number;
}
