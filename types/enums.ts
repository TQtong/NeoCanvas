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
  'frame',
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

/**
 * 模型提供商标识。用于适配器路由与 `model_catalog.provider`。
 */
export const PROVIDERS = ['openai', 'google', 'volcengine', 'fal', 'replicate'] as const;
export type Provider = (typeof PROVIDERS)[number];

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
export const SHAPE_KINDS = ['rectangle', 'ellipse', 'triangle', 'diamond', 'line', 'arrow'] as const;
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
