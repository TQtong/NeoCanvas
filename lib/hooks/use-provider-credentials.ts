'use client';

/**
 * 提供商凭证（BYOK）管理钩子。
 *
 * 读取：经 RLS 直查 `provider_credentials`（仅本人、脱敏元数据，无明文 Key）。
 * 写入 / 启停 / 删除 / 测试：经 `provider-credentials` 边缘函数（service_role + Vault），
 * 明文 Key 只上行至边缘、永不回流客户端。
 *
 * @module lib/hooks/use-provider-credentials
 */

import { useCallback, useEffect, useState } from 'react';
import type {
  Provider,
  ProviderCredential,
  ProviderCredentialRow,
  ProviderCredentialsRequest,
  ProviderCredentialsResponse,
  ProviderTestResult,
} from '@/types';
import { EDGE_FUNCTIONS } from '@/types';
import { getBrowserSupabase } from '@/lib/supabase/client';
import { invokeEdge } from '@/lib/edge/client';

/** 行 → 前端脱敏视图。 */
function rowToCredential(row: ProviderCredentialRow): ProviderCredential {
  return {
    id: row.id,
    provider: row.provider,
    label: row.label ?? null,
    baseUrl: row.base_url ?? null,
    keyLast4: row.key_last4,
    enabled: row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 保存凭证入参。 */
export interface SaveCredentialInput {
  provider: Provider;
  /** 明文 Key；留空表示沿用既有 Key（仅改 base_url / enabled）。 */
  apiKey?: string;
  baseUrl?: string | null;
  enabled?: boolean;
}

/** 连通性测试入参。 */
export interface TestCredentialInput {
  provider: Provider;
  /** 待测 Key；留空则测试已存 Key。 */
  apiKey?: string;
  baseUrl?: string | null;
}

/** useProviderCredentials 返回值。 */
export interface UseProviderCredentials {
  /** 当前用户的凭证列表（脱敏）。 */
  credentials: ProviderCredential[];
  /** 是否加载中。 */
  loading: boolean;
  /** 重新拉取列表。 */
  refresh: () => Promise<void>;
  /** 新建 / 覆盖凭证。 */
  saveCredential: (input: SaveCredentialInput) => Promise<ProviderCredential>;
  /** 启停凭证。 */
  toggleCredential: (provider: Provider, enabled: boolean) => Promise<ProviderCredential>;
  /** 删除凭证。 */
  deleteCredential: (id: string) => Promise<void>;
  /** 连通性测试（不落库）。 */
  testCredential: (input: TestCredentialInput) => Promise<ProviderTestResult>;
}

/**
 * 提供商凭证管理钩子。
 *
 * @returns 凭证列表与增删改测动作
 */
export function useProviderCredentials(): UseProviderCredentials {
  const [credentials, setCredentials] = useState<ProviderCredential[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    const { data } = await getBrowserSupabase()
      .from('provider_credentials')
      .select('*')
      .order('provider', { ascending: true });
    setCredentials((data ?? []).map(rowToCredential));
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const saveCredential = useCallback(
    async (input: SaveCredentialInput): Promise<ProviderCredential> => {
      const res = await invokeEdge<ProviderCredentialsRequest, ProviderCredentialsResponse>(
        EDGE_FUNCTIONS.providerCredentials,
        { action: 'save', ...input },
      );
      await refresh();
      if (res.action !== 'save') throw new Error('保存返回异常');
      return res.credential;
    },
    [refresh],
  );

  const toggleCredential = useCallback(
    async (provider: Provider, enabled: boolean): Promise<ProviderCredential> => {
      const res = await invokeEdge<ProviderCredentialsRequest, ProviderCredentialsResponse>(
        EDGE_FUNCTIONS.providerCredentials,
        { action: 'toggle', provider, enabled },
      );
      await refresh();
      if (res.action !== 'toggle') throw new Error('启停返回异常');
      return res.credential;
    },
    [refresh],
  );

  const deleteCredential = useCallback(
    async (id: string): Promise<void> => {
      await invokeEdge<ProviderCredentialsRequest, ProviderCredentialsResponse>(
        EDGE_FUNCTIONS.providerCredentials,
        { action: 'delete', id },
      );
      await refresh();
    },
    [refresh],
  );

  const testCredential = useCallback(
    async (input: TestCredentialInput): Promise<ProviderTestResult> => {
      const res = await invokeEdge<ProviderCredentialsRequest, ProviderCredentialsResponse>(
        EDGE_FUNCTIONS.providerCredentials,
        { action: 'test', ...input },
      );
      if (res.action !== 'test') throw new Error('测试返回异常');
      return res.result;
    },
    [],
  );

  return {
    credentials,
    loading,
    refresh,
    saveCredential,
    toggleCredential,
    deleteCredential,
    testCredential,
  };
}
