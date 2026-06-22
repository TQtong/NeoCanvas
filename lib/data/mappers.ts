/**
 * 服务端 / 客户端共用的行 → 视图映射（无框架依赖，可在 RSC 与客户端引用）。
 *
 * @module lib/data/mappers
 */

import type { MessageRow, MessageView, ProjectRow, ProjectSummary } from '@/types';

/** 「最近项目」每页数量。集中此处以便服务端与客户端共用而不跨越 'use client' 边界。 */
export const PROJECTS_PAGE_SIZE = 24;

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
