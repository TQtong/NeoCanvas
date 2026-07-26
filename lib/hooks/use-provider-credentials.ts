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
  BuiltInProvider,
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

/** 凭据发生变化时通知已挂载的节点面板重新读取，避免各 Hook 副本使用旧快照。 */
export const PROVIDER_CREDENTIALS_CHANGED_EVENT = 'neocanvas:provider-credentials-changed';

/** 凭据变更事件携带的脱敏状态，供已打开的节点即时更新。 */
interface ProviderCredentialsChangedDetail {
  credential?: ProviderCredential;
  deletedId?: string;
}

/** 广播提供商凭据变化（仅浏览器端执行）。 */
function notifyProviderCredentialsChanged(detail: ProviderCredentialsChangedDetail): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent<ProviderCredentialsChangedDetail>(PROVIDER_CREDENTIALS_CHANGED_EVENT, {
        detail,
      }),
    );
  }
}

/** 行 → 前端脱敏视图。 */
function rowToCredential(row: ProviderCredentialRow): ProviderCredential {
  return {
    id: row.id,
    provider: row.provider,
    adapter: row.adapter,
    label: row.label ?? null,
    websiteUrl: row.website_url ?? null,
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
  /** 实际请求协议；内置提供商与 provider 一致。 */
  adapter?: BuiltInProvider;
  /** 明文 Key；留空表示沿用既有 Key（仅改 base_url / enabled）。 */
  apiKey?: string;
  /** 双密钥提供商的 Secret Access Key。 */
  apiSecret?: string;
  baseUrl?: string | null;
  label?: string | null;
  websiteUrl?: string | null;
  enabled?: boolean;
}

/** 连通性测试入参。 */
export interface TestCredentialInput {
  provider: Provider;
  adapter?: BuiltInProvider;
  /** 待测 Key；留空则测试已存 Key。 */
  apiKey?: string;
  apiSecret?: string;
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
    const { data, error } = await getBrowserSupabase()
      .from('provider_credentials')
      .select('*')
      .order('provider', { ascending: true });
    // 查询异常时保留当前快照，避免一次短暂的网络/RLS 错误把节点筛选清空。
    if (!error) setCredentials((data ?? []).map(rowToCredential));
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 设置页与画布节点各自使用本 Hook；监听全局事件使配置保存后已打开的节点即时更新。
  useEffect(() => {
    const onChanged = (event: Event): void => {
      const detail = (event as CustomEvent<ProviderCredentialsChangedDetail>).detail;
      const credential = detail?.credential;
      if (credential) {
        setCredentials((current) => {
          const next = current.filter((item) => item.provider !== credential.provider);
          return [...next, credential].sort((a, b) => a.provider.localeCompare(b.provider));
        });
      } else if (detail?.deletedId) {
        setCredentials((current) => current.filter((item) => item.id !== detail.deletedId));
      }
      void refresh();
    };
    window.addEventListener(PROVIDER_CREDENTIALS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(PROVIDER_CREDENTIALS_CHANGED_EVENT, onChanged);
  }, [refresh]);

  const saveCredential = useCallback(
    async (input: SaveCredentialInput): Promise<ProviderCredential> => {
      const res = await invokeEdge<ProviderCredentialsRequest, ProviderCredentialsResponse>(
        EDGE_FUNCTIONS.providerCredentials,
        { action: 'save', ...input },
      );
      await refresh();
      if (res.action !== 'save') throw new Error('保存返回异常');
      notifyProviderCredentialsChanged({ credential: res.credential });
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
      notifyProviderCredentialsChanged({ credential: res.credential });
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
      notifyProviderCredentialsChanged({ deletedId: id });
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
