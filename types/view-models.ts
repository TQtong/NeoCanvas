/**
 * 前端领域视图模型。
 *
 * 这些类型是数据库行经映射后供 UI 直接消费的形状（camelCase，含运行时注入字段如
 * 签名 URL、流式状态）。它们不引入任何前端框架依赖，故可被前端与能力面安全共享。
 *
 * @module types/view-models
 */

import type {
  AgentMode,
  AssetKind,
  AssetSource,
  GenerationStatus,
  MessageRole,
  Modality,
  Scene,
} from './enums';
import type { MessageAttachment, MessageMention } from './messages';

/**
 * 「最近项目」卡片所需的项目摘要。
 */
export interface ProjectSummary {
  /** 项目标识。 */
  id: string;
  /** 项目名。 */
  title: string;
  /** 缩略图签名 URL（运行时注入）。 */
  thumbnailUrl: string | null;
  /** 更新时间（ISO）。 */
  updatedAt: string;
  /** 创建时间（ISO）。 */
  createdAt: string;
  /** 最近打开时间（ISO）。 */
  lastOpenedAt: string | null;
  /** 创建时所选场景。 */
  scene: Scene | null;
  /** 创建时所选默认模型键。 */
  defaultModelKey: string | null;
}

/**
 * 资产视图：资产元信息 + 解析后的访问 URL。
 */
export interface AssetView {
  /** 资产标识。 */
  id: string;
  /** 种类。 */
  kind: AssetKind;
  /** 来源。 */
  source: AssetSource;
  /** MIME 类型。 */
  mimeType: string;
  /** 像素宽。 */
  width: number | null;
  /** 像素高。 */
  height: number | null;
  /** 视频时长（毫秒）。 */
  durationMs: number | null;
  /** 原始媒体签名 URL（运行时注入）。 */
  url: string;
  /** 缩略图签名 URL（运行时注入）。 */
  thumbnailUrl: string | null;
  /** 当前签名 URL 的到期时间（ISO），用于长会话提前续签。 */
  expiresAt: string;
}

/**
 * 生成任务视图，驱动占位节点与对话进行态。
 */
export interface GenerationView {
  /** 任务标识。 */
  id: string;
  /** 模态。 */
  modality: Modality;
  /** 模型键。 */
  modelKey: string;
  /** 状态。 */
  status: GenerationStatus;
  /** 进度 0..100。 */
  progress: number;
  /** 占位节点标识。 */
  placeholderNodeId: string | null;
  /** 主产出资产标识。 */
  resultAssetId: string | null;
  /** 失败原因。 */
  error: string | null;
  /** 提示词。 */
  prompt: string | null;
}

/**
 * 消息视图，含运行时流式状态。
 */
export interface MessageView {
  /** 消息标识。 */
  id: string;
  /** 角色。 */
  role: MessageRole;
  /** 文本内容。 */
  content: string;
  /** 模型键。 */
  modelKey: string | null;
  /** Agent 模式。 */
  agentMode: AgentMode | null;
  /** 提及列表。 */
  mentions: MessageMention[];
  /** 附件列表。 */
  attachments: MessageAttachment[];
  /** 创建时间（ISO）。 */
  createdAt: string;
  /** 助手消息所回应的用户消息标识，用于恢复生成任务关联。 */
  userMessageId?: string | null;
  /** 运行时：是否正在流式接收（助手消息）。 */
  streaming?: boolean;
  /** 运行时：本条消息触发的生成任务标识集合。 */
  generationIds?: string[];
  /** 运行时：乐观追加但尚未确认持久化。 */
  pending?: boolean;
}

/**
 * 会话视图。
 */
export interface ConversationView {
  /** 会话标识。 */
  id: string;
  /** 标题。 */
  title: string;
  /** 消息流（按时间升序）。 */
  messages: MessageView[];
}
