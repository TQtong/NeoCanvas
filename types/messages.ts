/**
 * 消息中的提及与附件契约。
 *
 * `mentions` 与 `attachments` 是 `messages` 表的两个 JSONB 数组（见第 03 篇）。
 * 提及的节点标识即 `canvas_nodes` 行标识，与节点映射、生成请求的参考素材引用三者
 * 共用同一套标识语义（第 06 篇第八节），使「针对画布上具体元素再生成」类型安全。
 *
 * @module types/messages
 */

import type { AssetKind, NodeType } from './enums';

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
