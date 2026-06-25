/**
 * 统一生成请求、参数与资产候选契约。
 *
 * 这些类型是 `submit-generation`、`agent-orchestrate` 的请求形状，以及适配器
 * 归一化（normalize）输出的形状（第 05 篇第四节、第 06 篇第八节）。各模型实际支持
 * 的参数子集由 {@link ModelCapabilities} 声明，流水线据此校验并对不支持的参数降级
 * 或拒绝。
 *
 * @module types/generation
 */

import type { AssetKind, Modality } from './enums';

/**
 * 常见输出比例。具体模型支持哪些由能力画像声明。
 */
export const ASPECT_RATIOS = ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3'] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];

/** 图像质量档。 */
export const IMAGE_QUALITIES = ['low', 'medium', 'high', 'auto'] as const;
export type ImageQuality = (typeof IMAGE_QUALITIES)[number];

/**
 * 参考素材引用。来自 `@` 提及的画布节点或上传附件，按模型能力作为参考图 / 首帧传入。
 * 节点标识与附件资产标识共用同一套引用语义（第 06 篇第八节）。
 */
export interface ReferenceMaterial {
  /** 引用来源：画布节点提及，或上传附件。 */
  origin: 'node' | 'attachment';
  /** 当来源为 node：被引用的 `canvas_nodes.id`。 */
  nodeId?: string;
  /** 解析后用于取媒体的 `assets.id`（node 提及时取其绑定资产）。 */
  assetId: string;
  /**
   * 参考作用：风格 / 内容 / 首帧 / 蒙版 / 关键帧。
   * `keyframe` 专用于 {@link VideoGenerationParams.keyframes} 的有序关键帧序列。
   */
  role: 'style' | 'content' | 'first_frame' | 'mask' | 'keyframe';
}

/**
 * 图像生成参数。
 */
export interface ImageGenerationParams {
  modality: 'image';
  /** 负向提示（按模型支持）。 */
  negativePrompt?: string;
  /** 输出比例（与显式宽高二选一）。 */
  aspectRatio?: AspectRatio;
  /** 显式输出宽（px）。 */
  width?: number;
  /** 显式输出高（px）。 */
  height?: number;
  /** 产出数量（单次最大数受能力画像约束）。 */
  count: number;
  /** 质量档。 */
  quality?: ImageQuality;
  /** 随机种子（可复现）。 */
  seed?: number;
  /** 参考素材（图生图 / 编辑 / 风格参考）。 */
  references: ReferenceMaterial[];
}

/**
 * 视频生成参数。
 */
export interface VideoGenerationParams {
  modality: 'video';
  /** 时长（秒）。 */
  durationSec: number;
  /** 分辨率档（如 '480p'、'720p'、'1080p'）。 */
  resolution: string;
  /** 输出比例。 */
  aspectRatio?: AspectRatio;
  /** 帧率。 */
  fps?: number;
  /** 运动强度，0..1（按模型支持）。 */
  motionStrength?: number;
  /** 随机种子。 */
  seed?: number;
  /** 参考素材（首帧 / 参考图，图生视频）。 */
  references: ReferenceMaterial[];
  /**
   * 有序关键帧序列（「逐段首尾帧」合成模式）。
   *
   * 当存在且长度 ≥ 2 时，按数组顺序相邻两帧构成一段图生视频（前者为首帧、后者为尾帧），
   * 各段拼接为一条完整视频；此模式与 {@link references} 的单一首帧模式互斥，由画布上
   * 用户手动连接的 `sequence` 边解析而来（第 05 篇生成编排）。每个元素 `role` 取 `keyframe`，
   * 顺序即合成顺序。
   */
  keyframes?: ReferenceMaterial[];
}

/**
 * 文本 / 文案生成参数。
 */
export interface TextGenerationParams {
  modality: 'text';
  /** 最大生成 token 数。 */
  maxTokens?: number;
  /** 采样温度，0..2。 */
  temperature?: number;
  /** 生成约束（如风格、长度、格式要求）。 */
  constraints?: string;
  /** 参考素材（看图写文案等）。 */
  references: ReferenceMaterial[];
}

/**
 * 生成参数判别联合，以 `modality` narrow。映射 `generations.params` JSONB。
 */
export type GenerationParams = ImageGenerationParams | VideoGenerationParams | TextGenerationParams;

/**
 * 按模态取出对应参数形状的工具类型。
 */
export type GenerationParamsOf<M extends Modality> = Extract<GenerationParams, { modality: M }>;

/**
 * 占位节点的落位描述：在画布上以何处、何尺寸创建生成占位。
 */
export interface NodePlacement {
  /** flow 逻辑坐标 X。 */
  x: number;
  /** flow 逻辑坐标 Y。 */
  y: number;
  /** 占位宽（px）。 */
  width: number;
  /** 占位高（px）。 */
  height: number;
  /** 父画板节点标识（如落在某画板内）。 */
  parentId?: string | null;
}

/**
 * 统一生成请求：`submit-generation` 接受的请求体（第 06 篇第四节提交生成）。
 */
export interface UnifiedGenerationRequest {
  /** 项目标识。 */
  projectId: string;
  /** 会话标识（触发的会话）。 */
  conversationId: string | null;
  /** 触发消息标识（可空）。 */
  messageId: string | null;
  /** 模态。 */
  modality: Modality;
  /** 模型键，对应 `model_catalog.key`。 */
  modelKey: string;
  /** 提示词。 */
  prompt: string;
  /** 归一化生成参数（含参考素材）。 */
  params: GenerationParams;
  /** 幂等键，防重复提交。 */
  idempotencyKey: string;
  /** 占位落位（缺省时由服务端置于视口 / 画布中心）。 */
  placement?: NodePlacement;
  /**
   * 客户端预创建的占位节点标识（可选）。提供时服务端以该 id upsert 占位节点，使画布
   * 占位即时可见且与实时回流去重；缺省时由服务端生成占位 id。
   */
  placeholderNodeId?: string;
}

/**
 * 资产候选：适配器归一化（normalize）的输出，是流水线落库的输入契约。
 * 描述「如何取到这份媒体」与其元信息，供完成阶段取回转存 Storage 并建资产。
 */
export interface AssetCandidate {
  /** 资产种类。 */
  kind: AssetKind;
  /** MIME 类型。 */
  mimeType: string;
  /**
   * 媒体获取方式：
   * - `url`：可下载的（多为临时）URL，完成阶段须取回转存自有 Storage
   * - `base64`：内联 Base64（data 为不含前缀的编码串）
   * - `bytes`：已在内存中的二进制（Edge 内部直接落库）
   */
  fetch:
    | { type: 'url'; url: string; headers?: Record<string, string> }
    | { type: 'base64'; data: string }
    | { type: 'bytes'; bytes: Uint8Array };
  /** 像素宽（图 / 视频帧）。 */
  width?: number;
  /** 像素高。 */
  height?: number;
  /** 视频时长（毫秒）。 */
  durationMs?: number;
  /** 文件字节数（已知时）。 */
  sizeBytes?: number;
  /** 是否为提供商临时链接（true 时必须转存，杜绝外链失效）。 */
  isEphemeral: boolean;
}

/**
 * 适配器提交的结果：同步模型直接给出候选；异步模型给出外部任务号。
 */
export type SubmitResult =
  | { kind: 'sync'; candidates: AssetCandidate[] }
  | { kind: 'async'; externalJobId: string; progress?: number };

/**
 * 适配器查询的结果（仅异步模型）。
 */
export type PollResult =
  | { status: 'running'; progress: number }
  | { status: 'succeeded'; candidates: AssetCandidate[] }
  | { status: 'failed'; error: string };
