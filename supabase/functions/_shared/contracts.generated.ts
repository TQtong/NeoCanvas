/**
 * 此文件由 scripts/generate-edge-contracts.mjs 从根 types/ 生成。
 * 禁止手工修改；请修改根契约后运行 npm run contracts:generate。
 */

// ---------------------------------------------------------------------------
// SOURCE: types/enums.ts
// ---------------------------------------------------------------------------

/**
 * 系统枚举的 TypeScript 镜像。
 *
 * 这些字面量联合与第 03 篇定义的 PostgreSQL 枚举类型逐字一致，是前端、Edge
 * Functions 与数据库三方共享的取值契约。任何新增取值都必须同步修改对应的数据库
 * 枚举迁移，杜绝字面量漂移。
 *
 * @module types/enums
 */

/**
 * 生成模态：图像 / 视频 / 文本。
 * 对应数据库枚举 `modality`。
 */
export const MODALITIES = ['image', 'video', 'text'] as const;
export type Modality = (typeof MODALITIES)[number];

/**
 * 生成任务状态。对应数据库枚举 `generation_status`。
 *
 * - `pending`：已创建待入队 / 待运行
 * - `running`：运行中
 * - `succeeded`：成功（终态）
 * - `failed`：失败（终态）
 * - `cancelled`：取消（终态）
 *
 * 状态机单向转移：pending → running →（succeeded / failed / cancelled）。
 */
export const GENERATION_STATUSES = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export type GenerationStatus = (typeof GENERATION_STATUSES)[number];

/** 处于终态的生成状态集合，已终态者忽略一切迟到的推进事件。 */
export const TERMINAL_GENERATION_STATUSES: ReadonlySet<GenerationStatus> = new Set([
  'succeeded',
  'failed',
  'cancelled',
]);

/**
 * 消息角色。对应数据库枚举 `message_role`。
 */
export const MESSAGE_ROLES = ['user', 'assistant', 'system'] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

/**
 * 资产种类。对应数据库枚举 `asset_kind`。
 */
export const ASSET_KINDS = ['image', 'video'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

/**
 * 资产来源：上传 / 生成。对应数据库枚举 `asset_source`。
 */
export const ASSET_SOURCES = ['upload', 'generation'] as const;
export type AssetSource = (typeof ASSET_SOURCES)[number];

/**
 * 画布节点类型。对应数据库枚举 `node_type`，也与 React Flow 的 nodeTypes 注册键
 * 一一对应（见 lib/canvas/node-mapper）。
 */
export const NODE_TYPES = [
  'image',
  'text',
  'shape',
  'drawing',
  'video',
  'generation_placeholder',
  'media_panel',
  'frame',
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

/**
 * 模型提供商标识。用于适配器路由与 `model_catalog.provider`。
 */
export const BUILT_IN_PROVIDERS = [
  'openai',
  'google',
  'volcengine',
  'jimeng',
  'minimax',
  'fal',
  'replicate',
  'siliconflow',
] as const;

/** 服务端已经实现原生协议适配器的内置提供商。 */
export type BuiltInProvider = (typeof BUILT_IN_PROVIDERS)[number];

/** 用户创建的兼容供应商使用独立、稳定的路由标识。 */
export type CustomProvider = `custom:${string}`;

/**
 * 模型提供商实例标识。
 *
 * 内置提供商直接使用固定字面量；自定义提供商使用 `custom:*`，其实际请求协议由凭证的
 * `adapter` 字段决定，因此同一用户可以同时配置多个兼容供应商。
 */
export type Provider = BuiltInProvider | CustomProvider;

/** 兼容旧调用方的内置提供商清单别名。 */
export const PROVIDERS = BUILT_IN_PROVIDERS;

/** 判断提供商实例是否为用户自定义。 */
export function isCustomProvider(provider: Provider | string): provider is CustomProvider {
  return provider.startsWith('custom:');
}

/**
 * 创作场景。对应主页选择条与 `projects.initial_scene`。
 */
export const SCENES = ['design', 'branding', 'ecommerce', 'video'] as const;
export type Scene = (typeof SCENES)[number];

/**
 * 智能体工作模式。对应对话面板 Agent 下拉与 `messages.agent_mode`。
 *
 * - `generate`：纯生成模式，消息直接映射为一次生成提交
 * - `orchestrate`：编排式智能体，先理解意图再组织多步生成
 * - `scene`：场景流程模式，按场景预置模板与画布初始结构编排
 */
export const AGENT_MODES = ['generate', 'orchestrate', 'scene'] as const;
export type AgentMode = (typeof AGENT_MODES)[number];

/**
 * 形状种类。承载于 shape 节点的 `data.shape`。
 */
export const SHAPE_KINDS = [
  'rectangle',
  'ellipse',
  'triangle',
  'diamond',
  'line',
  'arrow',
] as const;
export type ShapeKind = (typeof SHAPE_KINDS)[number];

/**
 * 文本水平对齐方式。
 */
export const TEXT_ALIGNS = ['left', 'center', 'right', 'justify'] as const;
export type TextAlign = (typeof TEXT_ALIGNS)[number];

/**
 * 画布背景网格样式，对应底部工具栏「画板 / 网格」工具切换。
 */
export const BACKGROUND_VARIANTS = ['dots', 'lines', 'cross', 'none'] as const;
export type BackgroundVariant = (typeof BACKGROUND_VARIANTS)[number];

// ---------------------------------------------------------------------------
// SOURCE: types/messages.ts
// ---------------------------------------------------------------------------

/**
 * 消息中的提及与附件契约。
 *
 * `mentions` 与 `attachments` 是 `messages` 表的两个 JSONB 数组（见第 03 篇）。
 * 提及的节点标识即 `canvas_nodes` 行标识，与节点映射、生成请求的参考素材引用三者
 * 共用同一套标识语义（第 06 篇第八节），使「针对画布上具体元素再生成」类型安全。
 *
 * @module types/messages
 */

/**
 * 被 `@` 提及的画布节点引用。生成时被解析为参考图 / 首帧传入适配器。
 */
export interface MessageMention {
  /** 被提及节点标识，等于 `canvas_nodes.id`。 */
  nodeId: string;
  /** 节点类型，用于在提及标签上展示类型图标。 */
  nodeType: NodeType;
  /** 展示用标签（如文本摘要、图片别名）。 */
  label: string;
  /** 若节点绑定资产，其资产标识，便于直接取媒体作参考。 */
  assetId?: string | null;
}

/**
 * 附件资产引用。来自「+」上传，作为参考素材随消息提交。
 */
export interface MessageAttachment {
  /** 资产标识，等于 `assets.id`。 */
  assetId: string;
  /** 资产种类。 */
  kind: AssetKind;
  /** 文件名 / 展示名。 */
  name: string;
  /** MIME 类型。 */
  mimeType: string;
  /** 缩略展示用的签名 URL（运行时注入，不持久化进数组）。 */
  thumbnailUrl?: string;
}

/**
 * 客户端组装、提交给能力面的一条用户消息草稿载荷。
 */
export interface MessageDraft {
  /** 文本内容。 */
  content: string;
  /** 提及列表。 */
  mentions: MessageMention[];
  /** 附件列表。 */
  attachments: MessageAttachment[];
}

// ---------------------------------------------------------------------------
// SOURCE: types/generation.ts
// ---------------------------------------------------------------------------

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
  /** UI 尺寸预设；提交给服务端用于回填配置，提供商适配器只消费 width / height。 */
  sizePreset?: '1k' | '2k' | '4k' | '8k' | 'custom';
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

/** 生成结果落到画布时的语义。 */
export type GenerationResultMode = 'new_primary' | 'candidate_for_target';

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
  /** 结果归属的主媒体节点。候选生成时必填；新主媒体生成时可为空。 */
  targetNodeId?: string | null;
  /** 结果是新主媒体，还是某个主媒体的候选历史。 */
  resultMode?: GenerationResultMode;
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

// ---------------------------------------------------------------------------
// SOURCE: types/models.ts
// ---------------------------------------------------------------------------

/**
 * 模型目录与能力画像契约。
 *
 * 能力画像（{@link ModelCapabilities}）既驱动前端的参数 UI，又供流水线在提交前
 * 校验请求参数；它与适配器自声明的能力对齐，并存于 `model_catalog.capabilities`。
 *
 * @module types/models
 */

/**
 * 模型能力画像。声明该模型支持的参数子集与上限。
 */
export interface ModelCapabilities {
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

// ---------------------------------------------------------------------------
// SOURCE: types/providers.ts
// ---------------------------------------------------------------------------

/**
 * 模型提供商凭证（BYOK）契约。
 *
 * 用户在前端自助配置「模型提供商 + API Key」。明文 Key 永不下发客户端：库表与本契约
 * 只承载脱敏元数据（provider / base_url / 尾号 / 启停）。写入与连通性测试经
 * `provider-credentials` Edge Function（service_role + Vault），读取列表经 RLS 直查。
 *
 * @module types/providers
 */

/**
 * 前端消费的提供商凭证视图（脱敏）。由 `provider_credentials` 行映射，**不含明文 Key**。
 */
export interface ProviderCredential {
  /** 凭证标识。 */
  id: string;
  /** 提供商。 */
  provider: Provider;
  /** 实际调用的协议适配器。内置提供商与 provider 相同，自定义提供商由用户选择。 */
  adapter: BuiltInProvider;
  /** 可选展示标签。 */
  label: string | null;
  /** 提供商官网，仅用于设置页展示与跳转。 */
  websiteUrl: string | null;
  /** 可选自定义端点（OpenAI 兼容代理 / 自建网关）。 */
  baseUrl: string | null;
  /** Key 末 4 位，用于「••••abcd」展示。 */
  keyLast4: string;
  /** 是否启用（停用则解析时跳过、回退环境变量）。 */
  enabled: boolean;
  /** 创建时间（ISO）。 */
  createdAt: string;
  /** 更新时间（ISO）。 */
  updatedAt: string;
}

/**
 * `provider_credentials` 表行（snake_case，与列名逐字一致）。
 * 注意：**无明文 Key 列**；`key_secret_id` 仅为 vault 引用，客户端无法解密。
 */
export type ProviderCredentialRow = {
  id: string;
  user_id: string;
  provider: Provider;
  adapter: BuiltInProvider;
  label: string | null;
  website_url: string | null;
  base_url: string | null;
  key_last4: string;
  key_secret_id: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

/**
 * provider-credentials 请求：以 `action` 判别的联合。
 *
 * - `save`：新建 / 覆盖凭证（`apiKey` 为空表示沿用既有 Key，仅改 base_url / enabled）。
 * - `toggle`：启停既有凭证。
 * - `delete`：删除凭证（连同 Vault 机密）。
 * - `test`：连通性测试（用传入的 `apiKey`，或留空则用已存 Key）。
 */
export type ProviderCredentialsRequest =
  | {
    action: 'save';
    provider: Provider;
    adapter?: BuiltInProvider;
    apiKey?: string;
    /** 需要双密钥认证的提供商（当前为即梦）的 Secret Access Key。 */
    apiSecret?: string;
    baseUrl?: string | null;
    label?: string | null;
    websiteUrl?: string | null;
    enabled?: boolean;
  }
  | { action: 'toggle'; provider: Provider; enabled: boolean }
  | { action: 'delete'; id: string }
  | {
    action: 'test';
    provider: Provider;
    adapter?: BuiltInProvider;
    apiKey?: string;
    apiSecret?: string;
    baseUrl?: string | null;
  };

/** 连通性测试结果。 */
export interface ProviderTestResult {
  /** 是否连通（密钥被提供商接受）。 */
  ok: boolean;
  /** 探活的 HTTP 状态（如有）。 */
  status?: number;
  /** 失败时的简短说明。 */
  message?: string;
}

/**
 * provider-credentials 响应：随 `action` 不同而不同。
 * save / toggle 回脱敏凭证；delete 回是否删除；test 回连通结果。
 */
export type ProviderCredentialsResponse =
  | { action: 'save'; credential: ProviderCredential }
  | { action: 'toggle'; credential: ProviderCredential }
  | { action: 'delete'; deleted: boolean }
  | { action: 'test'; result: ProviderTestResult };

// ---------------------------------------------------------------------------
// SOURCE: types/api.ts
// ---------------------------------------------------------------------------

/**
 * 能力面统一响应封套与错误码契约（第 06 篇第五节）。
 *
 * 能力面（Edge Functions）的所有函数返回统一封套，使客户端以一致方式处理成败；
 * 数据面（PostgREST）的错误在数据访问层被归一为同一套错误码语义。错误码稳定且与
 * 展示文案解耦：码用于客户端分支与埋点，文案随用户语言本地化。
 *
 * @module types/api
 */

/**
 * 稳定的机器可读错误码族。
 */
export const ERROR_CODES = [
  'unauthorized',
  'forbidden',
  'invalid_params',
  'unsupported_param',
  'not_found',
  'content_blocked',
  'model_unavailable',
  'model_not_accessible',
  'provider_error',
  'provider_signature_invalid',
  'generation_timeout',
  'generation_terminal',
  'duplicate_request',
  'idempotency_conflict',
  'project_forbidden',
  'internal_auth_required',
  'conflict',
  'rate_limited',
  'internal_error',
] as const;

/** 错误码字面量联合。 */
export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * 错误负载。`message` 可向用户展示且可本地化；`details` 为可选细节。
 */
export interface ApiError {
  /** 稳定错误码。 */
  code: ErrorCode;
  /** 可展示、可本地化的消息。 */
  message: string;
  /** 可选细节（如校验失败字段、提供商原始错误摘要）。 */
  details?: Record<string, unknown>;
}

/**
 * 成功响应封套。
 */
export interface ApiSuccess<T> {
  success: true;
  data: T;
}

/**
 * 失败响应封套。
 */
export interface ApiFailure {
  success: false;
  error: ApiError;
}

/**
 * 统一响应封套：成功携带数据对象，失败携带错误。
 */
export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

/**
 * 把错误码映射到 HTTP 状态，用于 Edge Function 返回与数据面错误归一。
 */
export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  invalid_params: 400,
  unsupported_param: 400,
  not_found: 404,
  content_blocked: 422,
  model_unavailable: 409,
  model_not_accessible: 403,
  provider_error: 502,
  provider_signature_invalid: 401,
  generation_timeout: 504,
  generation_terminal: 409,
  duplicate_request: 200,
  idempotency_conflict: 409,
  project_forbidden: 403,
  internal_auth_required: 401,
  conflict: 409,
  rate_limited: 429,
  internal_error: 500,
};

// ---------------------------------------------------------------------------
// SOURCE: types/edge-functions.ts
// ---------------------------------------------------------------------------

/**
 * 能力面（Edge Functions）面向客户端的输入 / 输出契约。
 *
 * 前端 `lib/edge` 调用封装与各 Edge Function 共同引用本模块，确保两端对请求 / 响应
 * 形状的理解一致（第 06 篇第四节）。内部型函数（消费队列、轮询、回调）不面向客户端，
 * 其契约在各自实现内定义。
 *
 * @module types/edge-functions
 */

/** Edge Function 逻辑名常量，供调用封装与路由共用。 */
export const EDGE_FUNCTIONS = {
  createProject: 'create-project',
  submitGeneration: 'submit-generation',
  agentOrchestrate: 'agent-orchestrate',
  exportCanvas: 'export-canvas',
  processGenerationQueue: 'process-generation-queue',
  pollGenerations: 'poll-generations',
  cleanupGenerationStaging: 'cleanup-generation-staging',
  generationWebhook: 'generation-webhook',
  regeneratePoster: 'regenerate-poster',
  providerCredentials: 'provider-credentials',
  swapMediaCandidate: 'swap-media-candidate',
} as const;

/** create-project 请求。 */
export interface CreateProjectRequest {
  /** 初始想法（提示词文本）。 */
  prompt: string;
  /** 所选模型键；空白项目可为空，进入即生成时必须提供。 */
  modelKey: string | null;
  /** 所选场景（可空）。 */
  scene: Scene | null;
  /** 可选附件资产引用。 */
  attachments?: MessageAttachment[];
  /** 是否进入即生成首图（产品策略）。 */
  generateOnCreate: boolean;
  /** 客户端请求标识，避免连点重复建项目。 */
  clientRequestId?: string;
}

/** create-project 响应。 */
export interface CreateProjectResponse {
  /** 新项目标识，供重定向至 p/{projectId}。 */
  projectId: string;
  /** 主会话标识。 */
  conversationId: string;
  /** 首条用户消息标识。 */
  messageId: string;
  /** 若进入即生成，首个生成任务标识。 */
  generationId: string | null;
  /** 若进入即生成，画布占位节点标识。 */
  placeholderNodeId: string | null;
}

/** submit-generation 请求，即统一生成请求。 */
export type SubmitGenerationRequest = UnifiedGenerationRequest;

/** submit-generation 响应。 */
export interface SubmitGenerationResponse {
  /** 生成任务标识。 */
  generationId: string;
  /** 画布占位节点标识。 */
  placeholderNodeId: string;
  /** 是否为幂等命中（复用既有任务）。 */
  deduplicated: boolean;
  /** 原子提交涉及的节点（占位及候选面板）标识。 */
  nodeIds?: string[];
  /** 原子提交涉及的候选关系边标识。 */
  edgeIds?: string[];
  /** 持久队列消息标识（bigint 以字符串跨越 JSON 边界）。 */
  queueMessageId?: string | null;
}

/** 数据库原子提交 RPC 的完整返回契约。 */
export interface GenerationSubmissionResult {
  generationId: string;
  placeholderNodeId: string;
  nodeIds: string[];
  edgeIds: string[];
  queueMessageId: string | null;
  reused: boolean;
}

/** 单次结果落库 RPC 的返回契约。 */
export interface LandGenerationResult {
  landed: boolean;
  generationId: string;
  terminalStatus: 'succeeded' | 'failed' | 'cancelled';
  assetIds: string[];
  nodeIds: string[];
}

/** swap-media-candidate 请求。 */
export interface SwapMediaCandidateRequest {
  /** 当前项目。 */
  projectId: string;
  /** 主媒体节点 id。 */
  primaryNodeId: string;
  /** 候选媒体节点 id。 */
  candidateNodeId: string;
}

/** swap-media-candidate 响应。 */
export interface SwapMediaCandidateResponse {
  /** 是否完成替换。 */
  swapped: boolean;
}

/** agent-orchestrate 请求。 */
export interface AgentOrchestrateRequest {
  /** 项目标识。 */
  projectId: string;
  /** 会话标识。 */
  conversationId: string;
  /** 用户消息标识（客户端乐观写入后传入，用于去重）。 */
  messageId: string;
  /** 用户消息内容。 */
  content: string;
  /** 所选 Agent 模式。 */
  agentMode: AgentMode;
  /** 所选模型键。 */
  modelKey: string;
  /** `@` 提及的画布节点引用。 */
  mentions: MessageMention[];
  /** 附件资产引用。 */
  attachments: MessageAttachment[];
}

/**
 * agent-orchestrate 流式事件（SSE / 流式分块）。文本回复边生成边返回；
 * 图 / 视频走异步生成流水线，稍后经实时面落画布，这里仅回传其任务标识。
 */
export type AgentOrchestrateEvent =
  | { type: 'message_created'; assistantMessageId: string }
  | { type: 'text_delta'; delta: string }
  | { type: 'generation_started'; generationId: string; placeholderNodeId: string }
  | { type: 'done'; assistantMessageId: string; generationIds: string[] }
  | { type: 'error'; code: string; message: string };

/**
 * regenerate-poster 请求：以「成组海报」（背景图节点 + 同组文字节点）为参考，整组重新编排。
 *
 * 服务端：由现有文字重建主题 → 海报编排 LLM 产出新背景提示词与新文字版式 → 背景以图生图
 * 原地落在背景节点（placeholderNodeId = backgroundNodeId、参考原背景图）→ 删旧文字、建新的
 * 可编辑文字节点（沿用同一 groupId，使整组保持成组）。
 */
export interface RegeneratePosterRequest {
  /** 项目标识。 */
  projectId: string;
  /** 会话标识（可空）。 */
  conversationId: string | null;
  /** 海报逻辑组标识（同 groupId 的成员构成一张海报）。 */
  groupId: string;
  /** 作底图的背景图片节点标识（原地以其为占位重生成背景）。 */
  backgroundNodeId: string;
  /** 用于背景图生图的图像模型键。 */
  modelKey: string;
}

/** regenerate-poster 响应。 */
export interface RegeneratePosterResponse {
  /** 背景重生成任务标识。 */
  generationId: string;
  /** 背景占位节点标识（即 backgroundNodeId，原地）。 */
  placeholderNodeId: string;
  /** 新建的可编辑文字节点标识集合。 */
  textNodeIds: string[];
  /** 编排助手回复（说明本次海报构思）。 */
  reply: string;
}

/** export-canvas 选项。 */
export interface ExportCanvasOptions {
  /** 导出范围：整块画布或仅某画板 / 选区。 */
  scope: 'all' | 'frame' | 'selection';
  /** 当 scope 为 frame：目标画板节点标识。 */
  frameNodeId?: string;
  /** 当 scope 为 selection：选中节点标识集合。 */
  nodeIds?: string[];
  /** 输出格式。 */
  format: 'png' | 'jpeg' | 'svg' | 'pdf';
  /** 输出倍率（1..4）。 */
  scale: number;
}

/** export-canvas 请求。 */
export interface ExportCanvasRequest {
  /** 项目标识。 */
  projectId: string;
  /** 导出选项。 */
  options: ExportCanvasOptions;
}

/** export-canvas 响应。 */
export interface ExportCanvasResponse {
  /** 短时效签名下载链接。 */
  downloadUrl: string;
  /** 链接过期时间（ISO 字符串）。 */
  expiresAt: string;
  /** 导出件 MIME。 */
  mimeType: string;
}
