/**
 * 模型目录与能力画像契约。
 *
 * 能力画像（{@link ModelCapabilities}）既驱动前端的参数 UI，又供流水线在提交前
 * 校验请求参数；它与适配器自声明的能力对齐，并存于 `model_catalog.capabilities`。
 *
 * @module types/models
 */

import type { AgentMode, Modality, Provider } from './enums';
import type {
  AspectRatio,
  ImageInputFidelity,
  ImageOperation,
  ImageQuality,
  ImageUpscaleFactor,
} from './generation';

/**
 * 模型能力画像。声明该模型支持的参数子集与上限。
 */
export interface ModelCapabilities {
  /** 图片模型真实支持的生成 / 编辑操作；视频模型为空数组。 */
  imageOperations: ImageOperation[];
  /** 支持的输出比例集合。 */
  aspectRatios: AspectRatio[];
  /** 支持的显式尺寸（宽×高）枚举；为空表示由比例驱动。 */
  sizes: Array<{ width: number; height: number; label: string }>;
  /** 单次最大产出数。 */
  maxOutputs: number;
  /** 是否支持负向提示。 */
  supportsNegativePrompt: boolean;
  /** 是否支持参考图（图生图 / 风格参考 / 编辑）。 */
  supportsReferenceImages: boolean;
  /** 是否必须提供参考图（图片编辑 / 图生视频等不能纯文本生成的模型）。 */
  requiresReferenceImages?: boolean;
  /** 是否支持图生视频（首帧 / 参考图驱动）。 */
  supportsImageToVideo: boolean;
  /** 是否支持随机种子。 */
  supportsSeed: boolean;
  /** 支持的图像质量档（仅图像模型）。 */
  qualities: ImageQuality[];
  /** 是否为异步模型（提交后需轮询 / 回调）。 */
  isAsync: boolean;
  /** 是否支持提供商回调（用于 generation-webhook 推进）。 */
  supportsWebhook: boolean;
  /** 图片专属：最多接收多少张非蒙版输入图片。 */
  maxInputImages?: number;
  /** 图片专属：支持的输入保真度。缺省表示不接受该参数。 */
  inputFidelityOptions?: ImageInputFidelity[];
  /** 图片专属：支持的高清放大倍率。 */
  upscaleFactors?: ImageUpscaleFactor[];
  /** 图片专属：是否能产生透明背景。 */
  supportsTransparentOutput?: boolean;
  /** 图片专属：提交给 Provider 的单张输入总像素上限。 */
  maxInputPixels?: number;
  /** 视频专属：支持的分辨率档。 */
  videoResolutions?: string[];
  /** 视频专属：时长区间（秒）。 */
  videoDurationRange?: { min: number; max: number };
  /** 视频专属：是否支持运动强度调节。 */
  supportsMotionStrength?: boolean;
  /**
   * 视频专属：是否支持「有序关键帧序列」（逐段首尾帧）图生视频。
   * 区别于仅单首帧驱动的 {@link supportsImageToVideo}：为真才可接受由画布 `sequence` 链
   * 解析出的 ≥2 帧关键帧序列。前端据此筛选可用模型、后端 `validateParams` 据此放行。
   */
  supportsKeyframeSequence?: boolean;
}

/**
 * 判断模型目录能力是否明确开放某个图片操作。
 *
 * 不对缺失字段做乐观推断：数据库迁移前的旧能力对象视为不支持精准编辑，避免前端把
 * 尚未经过适配器验证的操作暴露给用户。
 */
export function modelSupportsImageOperation(
  capabilities: ModelCapabilities,
  operation: ImageOperation,
): boolean {
  return capabilities.imageOperations?.includes(operation) === true;
}

/**
 * 模型默认生成参数。新建生成时作为参数基线，被请求显式参数覆盖。
 * 字段与 {@link GenerationParams} 子集对齐，但全部可选（按模态各取所需）。
 */
export interface ModelDefaultParams {
  aspectRatio?: AspectRatio;
  width?: number;
  height?: number;
  count?: number;
  quality?: ImageQuality;
  resolution?: string;
  durationSec?: number;
  fps?: number;
  motionStrength?: number;
  temperature?: number;
  maxTokens?: number;
  /** 提供商侧端点 / 模型 id 覆盖（见 docs/SETUP.md 与 `resolveProviderModel`）。 */
  providerModel?: string;
}

/**
 * 前端消费的模型目录条目（由 `model_catalog` 行映射而来）。
 */
export interface ModelCatalogEntry {
  /** 模型键，如 gpt-image-2。 */
  key: string;
  /** 展示名，如 GPT Image 2。 */
  displayName: string;
  /** 提供商。 */
  provider: Provider;
  /** 模态。 */
  modality: Modality;
  /** 能力画像。 */
  capabilities: ModelCapabilities;
  /** 默认参数。 */
  defaultParams: ModelDefaultParams;
  /** 选择条排序。 */
  sortOrder: number;
  /** 是否上架（管理面板需区分启停；选择条只取已上架者）。 */
  isActive: boolean;
  /** 归属用户：null=内置种子（只读）；非空=该用户自有模型（可管理）。 */
  userId: string | null;
}

/**
 * Agent 模式条目，驱动对话面板的 Agent 下拉。
 */
export interface AgentModeEntry {
  /** 模式标识。 */
  mode: AgentMode;
  /** 展示名（保留英文原文以贴合草图，如 'Agent'、'Generate'）。 */
  label: string;
  /** 模式说明。 */
  description: string;
}
