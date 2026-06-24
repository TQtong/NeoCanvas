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
  };
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
