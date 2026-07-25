/**
 * 模型目录读取与映射。
 *
 * 模型选择条与对话面板的模型 / Agent 切换共用同一套模型目录（第 01 篇、第 04 篇）。
 * 此处把 `model_catalog` 行映射为前端消费的 {@link ModelCatalogEntry}，并把可用模型严格
 * 限定为当前用户已经配置且启用的提供商，避免展示无法调用的跨提供商模型。
 *
 * @module lib/models/catalog
 */

import type { AgentModeEntry, ModelCatalogEntry, ModelCatalogRow } from '@/types';
import type { TypedSupabaseClient } from '@/lib/supabase/types';

/**
 * 行 → 前端模型条目。
 *
 * @param row - model_catalog 行
 * @returns 模型条目
 */
export function modelRowToEntry(row: ModelCatalogRow): ModelCatalogEntry {
  return {
    key: row.key,
    displayName: row.display_name,
    provider: row.provider,
    modality: row.modality,
    capabilities: row.capabilities,
    defaultParams: row.default_params,
    sortOrder: row.sort_order,
    isActive: row.is_active,
    userId: row.user_id ?? null,
  };
}

/**
 * 拉取当前用户可用的模型目录（按 sort_order 升序）。
 *
 * 可用模型必须同时满足：模型已上架、所属提供商存在当前用户的凭据且该凭据已启用。
 * 任一查询失败时采用失败关闭策略返回空数组，不向界面暴露未经凭据确认的模型。
 *
 * @param supabase - Supabase 客户端
 * @returns 模型条目数组
 */
export async function fetchModelCatalog(
  supabase: TypedSupabaseClient,
): Promise<ModelCatalogEntry[]> {
  const { data: credentials, error: credentialsError } = await supabase
    .from('provider_credentials')
    .select('provider')
    .eq('enabled', true);
  if (credentialsError || !credentials) return [];

  const enabledProviders = [...new Set(credentials.map(({ provider }) => provider))];
  if (enabledProviders.length === 0) return [];

  const { data, error } = await supabase
    .from('model_catalog')
    .select('*')
    .eq('is_active', true)
    .in('provider', enabledProviders)
    .order('sort_order', { ascending: true });
  if (error || !data) return [];
  return data.map(modelRowToEntry);
}

/**
 * 拉取「可管理」的模型目录：经 RLS 返回「内置已上架 + 本人自有（含未上架）」全部条目，
 * 不按 is_active 过滤，供设置面板的模型管理列表使用（区分内置只读与自有可编辑）。
 *
 * @param supabase - Supabase 客户端（须为已登录用户态，RLS 据 auth.uid() 过滤）
 * @returns 模型条目数组（按 sort_order 升序）
 */
export async function fetchManageableModels(
  supabase: TypedSupabaseClient,
): Promise<ModelCatalogEntry[]> {
  const { data, error } = await supabase
    .from('model_catalog')
    .select('*')
    .order('sort_order', { ascending: true });
  if (error || !data) return [];
  return data.map(modelRowToEntry);
}

/**
 * 按键查找模型条目。
 *
 * @param entries - 模型条目数组
 * @param key - 模型键
 * @returns 命中的条目或 undefined
 */
export function findModel(
  entries: ModelCatalogEntry[],
  key: string | null | undefined,
): ModelCatalogEntry | undefined {
  if (!key) return undefined;
  return entries.find((e) => e.key === key);
}

/** Agent 模式静态清单（label 保留英文原文以贴合草图）。 */
export const AGENT_MODE_ENTRIES: AgentModeEntry[] = [
  { mode: 'generate', label: 'Generate', description: 'agent.generate.desc' },
  { mode: 'orchestrate', label: 'Agent', description: 'agent.orchestrate.desc' },
  { mode: 'scene', label: 'Scene', description: 'agent.scene.desc' },
];
