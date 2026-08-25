/**
 * 服务端 / 客户端共用的行 → 视图映射（无框架依赖，可在 RSC 与客户端引用）。
 *
 * @module lib/data/mappers
 */

import type {
  GenerationRow,
  GenerationView,
  MessageRow,
  MessageView,
  ProjectRow,
  ProjectSummary,
} from '@/types';

/** 「最近项目」每页数量。集中此处以便服务端与客户端共用而不跨越 'use client' 边界。 */
export const PROJECTS_PAGE_SIZE = 24;

/** 会话历史每页数量（keyset 分页，按 created_at 游标）。 */
export const MESSAGES_PAGE_SIZE = 50;

/**
 * 项目行 → 摘要。
 *
 * @param row - projects 行
 * @returns 项目摘要
 */
export function projectRowToSummary(row: ProjectRow): ProjectSummary {
  return {
    id: row.id,
    title: row.title,
    thumbnailUrl: row.thumbnail_url,
    updatedAt: row.updated_at,
    createdAt: row.created_at,
    lastOpenedAt: row.last_opened_at,
    scene: row.initial_scene,
    defaultModelKey: row.default_model_key,
  };
}

/**
 * 消息行 → 视图。
 *
 * @param row - messages 行
 * @returns 消息视图
 */
export function messageRowToView(row: MessageRow): MessageView {
  return {
    id: row.id,
    role: row.role,
    content: row.content ?? '',
    modelKey: row.model_key,
    agentMode: (row.agent_mode as MessageView['agentMode']) ?? null,
    mentions: row.mentions,
    attachments: row.attachments,
    createdAt: row.created_at,
    userMessageId: row.user_message_id,
  };
}

/**
 * 该消息是否有可渲染内容。
 *
 * 无正文、无附件、无提及，且非流式进行态、未触发任何生成的「退化消息」返回 false——典型来源
 * 是空白项目创建时落库的空内容首条用户消息。退化消息既不渲染气泡（避免空气泡），也不计入
 * 「是否空会话」的空态判断（从而空白项目仍展示引导大标题）。
 *
 * @param m - 消息视图
 * @returns 是否应渲染
 */
export function isRenderableMessage(m: MessageView): boolean {
  return (
    Boolean(m.content) ||
    m.attachments.length > 0 ||
    m.mentions.length > 0 ||
    Boolean(m.streaming) ||
    (m.generationIds?.length ?? 0) > 0
  );
}

/**
 * 生成任务行 → 视图（驱动占位节点进度与对话进行态）。
 *
 * @param row - generations 行
 * @returns 生成任务视图
 */
export function generationRowToView(row: GenerationRow): GenerationView {
  return {
    id: row.id,
    modality: row.modality,
    modelKey: row.model_key,
    status: row.status,
    progress: row.progress,
    placeholderNodeId: row.placeholder_node_id,
    resultAssetId: row.result_asset_id,
    error: row.error,
    prompt: row.prompt,
  };
}
