'use client';

/**
 * 用户自有模型管理钩子。
 *
 * 模型不涉及密钥，故增删改经 RLS 直接对 `model_catalog` 操作（仅本人自有行可写）。读取
 * 经 {@link fetchManageableModels} 返回「内置已上架 + 本人自有（含未上架）」全部条目。
 *
 * 自有模型须绑定到一个已配置凭证的 provider（由 UI 约束）；其 key 全局唯一（与内置 / 他人
 * 不可重名，DB 唯一约束保证）。
 *
 * @module lib/hooks/use-managed-models
 */

import { useCallback, useEffect, useState } from 'react';
import type {
  Modality,
  ModelCapabilities,
  ModelCatalogEntry,
  ModelDefaultParams,
  Provider,
} from '@/types';
import { getBrowserSupabase } from '@/lib/supabase/client';
import { fetchManageableModels } from '@/lib/models/catalog';
import { useSessionStore } from '@/stores/session-store';

/** 自有模型的可编辑字段。 */
export interface ManagedModelInput {
  /** 全局唯一键（如 my-flux-pro）。 */
  key: string;
  /** 展示名。 */
  displayName: string;
  /** 绑定的提供商（须已配置凭证）。 */
  provider: Provider;
  /** 模态。 */
  modality: Modality;
  /** 能力画像。 */
  capabilities: ModelCapabilities;
  /** 默认参数（含 providerModel 提供商侧模型 id）。 */
  defaultParams: ModelDefaultParams;
  /** 是否上架（默认 true）。 */
  isActive?: boolean;
}

/** 自有模型默认排序：排在内置模型（5..40）之后。 */
const USER_MODEL_SORT = 1000;

/** useManagedModels 返回值。 */
export interface UseManagedModels {
  /** 可见模型（内置 + 自有）。 */
  models: ModelCatalogEntry[];
  /** 是否加载中。 */
  loading: boolean;
  /** 重新拉取。 */
  refresh: () => Promise<void>;
  /** 新增一个自有模型。 */
  addModel: (input: ManagedModelInput) => Promise<void>;
  /** 编辑自有模型（按 key 定位，RLS 限本人）。 */
  updateModel: (key: string, input: ManagedModelInput) => Promise<void>;
  /** 删除自有模型。 */
  deleteModel: (key: string) => Promise<void>;
  /** 启停自有模型。 */
  toggleModel: (key: string, isActive: boolean) => Promise<void>;
}

/**
 * 用户自有模型管理钩子。
 *
 * @returns 模型列表与增删改动作
 */
export function useManagedModels(): UseManagedModels {
  const [models, setModels] = useState<ModelCatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    const entries = await fetchManageableModels(getBrowserSupabase());
    setModels(entries);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const addModel = useCallback(
    async (input: ManagedModelInput): Promise<void> => {
      const userId = useSessionStore.getState().profile?.id;
      if (!userId) throw new Error('未登录');
      const { error } = await getBrowserSupabase()
        .from('model_catalog')
        .insert({
          key: input.key,
          display_name: input.displayName,
          provider: input.provider,
          modality: input.modality,
          capabilities: input.capabilities,
          default_params: input.defaultParams,
          sort_order: USER_MODEL_SORT,
          is_active: input.isActive ?? true,
          user_id: userId,
        });
      if (error) throw new Error(error.message);
      await refresh();
    },
    [refresh],
  );

  const updateModel = useCallback(
    async (key: string, input: ManagedModelInput): Promise<void> => {
      const { error } = await getBrowserSupabase()
        .from('model_catalog')
        .update({
          display_name: input.displayName,
          provider: input.provider,
          modality: input.modality,
          capabilities: input.capabilities,
          default_params: input.defaultParams,
          is_active: input.isActive ?? true,
        })
        .eq('key', key);
      if (error) throw new Error(error.message);
      await refresh();
    },
    [refresh],
  );

  const deleteModel = useCallback(
    async (key: string): Promise<void> => {
      const { error } = await getBrowserSupabase().from('model_catalog').delete().eq('key', key);
      if (error) throw new Error(error.message);
      await refresh();
    },
    [refresh],
  );

  const toggleModel = useCallback(
    async (key: string, isActive: boolean): Promise<void> => {
      const { error } = await getBrowserSupabase()
        .from('model_catalog')
        .update({ is_active: isActive })
        .eq('key', key);
      if (error) throw new Error(error.message);
      await refresh();
    },
    [refresh],
  );

  return { models, loading, refresh, addModel, updateModel, deleteModel, toggleModel };
}
