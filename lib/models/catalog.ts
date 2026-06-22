/**
 * 模型目录读取与映射。
 *
 * 模型选择条与对话面板的模型 / Agent 切换共用同一套模型目录（第 01 篇、第 04 篇）。
 * 此处把 `model_catalog` 行映射为前端消费的 {@link ModelCatalogEntry}，并提供 Agent
 * 模式的静态清单。
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
  };
}

/**
 * 拉取已上架的模型目录（按 sort_order 升序）。
 *
 * @param supabase - Supabase 客户端
 * @returns 模型条目数组
 */
export async function fetchModelCatalog(
  supabase: TypedSupabaseClient,
): Promise<ModelCatalogEntry[]> {
  const { data, error } = await supabase
    .from('model_catalog')
    .select('*')
    .eq('is_active', true)
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
