/**
 * 能力面（Edge Functions, Deno）共享类型。
 *
 * Deno 运行时要求本地导入带显式扩展名，而前端 `types/` 采用无扩展名相对导入（面向
 * Next 打包器），二者无法直接跨界共享。故此处在边缘侧自包含地重声明流水线所需的契约，
 * 其字面量与字段与 `types/` 严格一致（第 06 篇第八节）。前端与边缘对同一结构的理解由
 * 评审保证一致，新增取值须两侧同步。
 *
 * @module functions/_shared/types
 */

// ---------------------------------------------------------------------------
// 枚举（与 types/enums.ts 逐字一致）
// ---------------------------------------------------------------------------
export type Modality = 'image' | 'video' | 'text';
export type GenerationStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type MessageRole = 'user' | 'assistant' | 'system';
export type AssetKind = 'image' | 'video';
export type AssetSource = 'upload' | 'generation';
export type NodeType =
  | 'image'
  | 'text'
  | 'shape'
  | 'drawing'
  | 'video'
  | 'generation_placeholder'
  | 'frame';
export type Provider = 'openai' | 'google' | 'volcengine' | 'fal' | 'replicate';
export type Scene = 'design' | 'branding' | 'ecommerce' | 'video';
export type AgentMode = 'generate' | 'orchestrate' | 'scene';

/** 处于终态的生成状态。 */
export const TERMINAL_STATUSES: ReadonlySet<GenerationStatus> = new Set([
  'succeeded',
  'failed',
  'cancelled',
]);

// ---------------------------------------------------------------------------
// 错误码与响应封套（与 types/api.ts 一致）
// ---------------------------------------------------------------------------
export type ErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'invalid_params'
  | 'unsupported_param'
  | 'not_found'
  | 'content_blocked'
  | 'model_unavailable'
  | 'provider_error'
  | 'generation_timeout'
  | 'duplicate_request'
  | 'conflict'
  | 'rate_limited'
  | 'internal_error';

export interface ApiError {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export type ApiResponse<T> = { success: true; data: T } | { success: false; error: ApiError };

export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  invalid_params: 400,
  unsupported_param: 400,
  not_found: 404,
  content_blocked: 422,
  model_unavailable: 409,
  provider_error: 502,
  generation_timeout: 504,
  duplicate_request: 200,
  conflict: 409,
  rate_limited: 429,
  internal_error: 500,
};

// ---------------------------------------------------------------------------
// 生成参数与统一请求（与 types/generation.ts 一致）
// ---------------------------------------------------------------------------
export type AspectRatio = '1:1' | '4:3' | '3:4' | '16:9' | '9:16' | '3:2' | '2:3';
export type ImageQuality = 'low' | 'medium' | 'high' | 'auto';

export interface ReferenceMaterial {
  origin: 'node' | 'attachment';
  nodeId?: string;
  assetId: string;
  role: 'style' | 'content' | 'first_frame' | 'mask';
}

export interface ImageGenerationParams {
  modality: 'image';
  negativePrompt?: string;
  aspectRatio?: AspectRatio;
  width?: number;
  height?: number;
  count: number;
  quality?: ImageQuality;
  seed?: number;
  references: ReferenceMaterial[];
}

export interface VideoGenerationParams {
  modality: 'video';
  durationSec: number;
  resolution: string;
  aspectRatio?: AspectRatio;
  fps?: number;
  motionStrength?: number;
  seed?: number;
  references: ReferenceMaterial[];
}

export interface TextGenerationParams {
  modality: 'text';
  maxTokens?: number;
  temperature?: number;
  constraints?: string;
  references: ReferenceMaterial[];
}

export type GenerationParams =
  | ImageGenerationParams
  | VideoGenerationParams
  | TextGenerationParams;

export interface NodePlacement {
  x: number;
  y: number;
  width: number;
  height: number;
  parentId?: string | null;
}

export interface UnifiedGenerationRequest {
  projectId: string;
  conversationId: string | null;
  messageId: string | null;
  modality: Modality;
  modelKey: string;
  prompt: string;
  params: GenerationParams;
  idempotencyKey: string;
  placement?: NodePlacement;
  placeholderNodeId?: string;
}

/** 适配器归一化输出。 */
export interface AssetCandidate {
  kind: AssetKind;
  mimeType: string;
  fetch:
    | { type: 'url'; url: string; headers?: Record<string, string> }
    | { type: 'base64'; data: string }
    | { type: 'bytes'; bytes: Uint8Array };
  width?: number;
  height?: number;
  durationMs?: number;
  sizeBytes?: number;
  isEphemeral: boolean;
}

export type SubmitResult =
  | { kind: 'sync'; candidates: AssetCandidate[] }
  | { kind: 'async'; externalJobId: string; progress?: number };

export type PollResult =
  | { status: 'running'; progress: number }
  | { status: 'succeeded'; candidates: AssetCandidate[] }
  | { status: 'failed'; error: string };

// ---------------------------------------------------------------------------
// 模型能力画像 / 默认参数（与 types/models.ts 逐字一致）
// ---------------------------------------------------------------------------

/** 模型默认生成参数（model_catalog.default_params 的结构化形状，全部可选）。 */
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

export interface ModelCapabilities {
  aspectRatios: AspectRatio[];
  sizes: Array<{ width: number; height: number; label: string }>;
  maxOutputs: number;
  supportsNegativePrompt: boolean;
  supportsReferenceImages: boolean;
  supportsImageToVideo: boolean;
  supportsSeed: boolean;
  qualities: ImageQuality[];
  isAsync: boolean;
  supportsWebhook: boolean;
  videoResolutions?: string[];
  videoDurationRange?: { min: number; max: number };
  supportsMotionStrength?: boolean;
}

// ---------------------------------------------------------------------------
// 消息提及 / 附件、Edge Function 请求 / 响应
// ---------------------------------------------------------------------------
export interface MessageMention {
  nodeId: string;
  nodeType: NodeType;
  label: string;
  assetId?: string | null;
}

export interface MessageAttachment {
  assetId: string;
  kind: AssetKind;
  name: string;
  mimeType: string;
  thumbnailUrl?: string;
}

export interface CreateProjectRequest {
  prompt: string;
  modelKey: string;
  scene: Scene | null;
  attachments?: MessageAttachment[];
  generateOnCreate: boolean;
  clientRequestId?: string;
}

export interface CreateProjectResponse {
  projectId: string;
  conversationId: string;
  messageId: string;
  generationId: string | null;
  placeholderNodeId: string | null;
}

export interface SubmitGenerationResponse {
  generationId: string;
  placeholderNodeId: string;
  deduplicated: boolean;
}

export interface AgentOrchestrateRequest {
  projectId: string;
  conversationId: string;
  messageId: string;
  content: string;
  agentMode: AgentMode;
  modelKey: string;
  mentions: MessageMention[];
  attachments: MessageAttachment[];
}

export interface ExportCanvasRequest {
  projectId: string;
  options: {
    scope: 'all' | 'frame' | 'selection';
    frameNodeId?: string;
    nodeIds?: string[];
    format: 'png' | 'jpeg' | 'svg' | 'pdf';
    scale: number;
  };
}

/** 数据库 model_catalog 行（边缘侧读取所需字段）。 */
export interface ModelCatalogRow {
  key: string;
  display_name: string;
  provider: Provider;
  modality: Modality;
  capabilities: ModelCapabilities;
  default_params: ModelDefaultParams;
  is_active: boolean;
}

/** 数据库 generations 行（边缘侧流水线所需字段）。 */
export interface GenerationRow {
  id: string;
  project_id: string;
  conversation_id: string | null;
  message_id: string | null;
  modality: Modality;
  model_key: string;
  provider: Provider;
  prompt: string | null;
  params: GenerationParams;
  status: GenerationStatus;
  progress: number;
  external_job_id: string | null;
  result_asset_id: string | null;
  placeholder_node_id: string | null;
  error: string | null;
  idempotency_key: string | null;
  moderation_status: string;
  moderation_reason: string | null;
  completed_at: string | null;
}
