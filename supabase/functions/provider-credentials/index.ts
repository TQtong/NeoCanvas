/**
 * 提供商凭证管理（provider-credentials）—— BYOK 凭证的写入 / 启停 / 删除 / 连通测试。
 *
 * 密钥不出边缘：明文 Key 只在本函数（service_role）内经 RPC 写入 Vault；客户端只读脱敏
 * 元数据（见 0006/0016 的 RLS）。写入与解密恒由 SECURITY DEFINER RPC 承担，本函数不直接
 * 触碰 `vault`。
 *
 * 动作（body.action）：
 *   · save   —— 新建 / 覆盖凭证（apiKey 为空表示沿用既有 Key，仅改 base_url / enabled）
 *   · toggle —— 启停既有凭证
 *   · delete —— 删除凭证（连同其 Vault 机密）
 *   · test   —— 连通性测试（用传入 Key，或留空则用已存 Key）
 *
 * @module functions/provider-credentials
 */

import {
  type ProviderCredential,
  type ProviderCredentialsRequest,
  type ProviderCredentialsResponse,
} from '../_shared/types.ts';
import { ApiException, exceptionToResponse, fail, handleCorsPreflight, ok } from '../_shared/response.ts';
import { createAdminClient, requireUser, type SupabaseClient } from '../_shared/supabase.ts';
import { PROVIDER_ENV, testProviderKey } from '../_shared/credentials.ts';

/** provider_credentials 行 → 前端脱敏视图。 */
function rowToCredential(row: Record<string, unknown>): ProviderCredential {
  return {
    id: row.id as string,
    provider: row.provider as ProviderCredential['provider'],
    label: (row.label as string | null) ?? null,
    baseUrl: (row.base_url as string | null) ?? null,
    keyLast4: row.key_last4 as string,
    enabled: row.enabled as boolean,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

/** 校验 provider 取值合法（与 PROVIDERS 一致）。 */
function assertProvider(provider: string): void {
  if (!(provider in PROVIDER_ENV)) {
    throw new ApiException('invalid_params', `未知提供商：${provider}`);
  }
}

/** `get_provider_api_key` RPC 行。 */
interface ProviderKeyRow {
  api_key: string | null;
  base_url: string | null;
  enabled: boolean;
}

/** 取某用户某 provider 已存的明文 Key（仅用于 test 动作，结果不外泄）。 */
async function fetchStoredKey(
  admin: SupabaseClient,
  userId: string,
  provider: string,
): Promise<{ apiKey: string; baseUrl: string | null } | null> {
  const { data } = await admin.rpc('get_provider_api_key', {
    p_user_id: userId,
    p_provider: provider,
  });
  const row = (Array.isArray(data) ? data[0] : data) as ProviderKeyRow | null | undefined;
  if (row && row.api_key) return { apiKey: row.api_key, baseUrl: row.base_url };
  return null;
}

Deno.serve(async (request) => {
  const preflight = handleCorsPreflight(request);
  if (preflight) return preflight;
  if (request.method !== 'POST') return fail('invalid_params', '仅支持 POST');

  try {
    const { userId } = await requireUser(request);
    const admin = createAdminClient();
    const body = (await request.json()) as ProviderCredentialsRequest;

    switch (body.action) {
      case 'save': {
        assertProvider(body.provider);
        const { data, error } = await admin.rpc('upsert_provider_credential', {
          p_user_id: userId,
          p_provider: body.provider,
          p_base_url: body.baseUrl ?? null,
          p_api_key: body.apiKey ?? null,
          p_enabled: body.enabled ?? true,
        });
        if (error) {
          // 22023：新建缺 Key（check_violation 之外的语义错误，归一为入参非法）
          throw new ApiException('invalid_params', error.message || '保存凭证失败');
        }
        return ok<ProviderCredentialsResponse>({
          action: 'save',
          credential: data as ProviderCredential,
        });
      }

      case 'toggle': {
        assertProvider(body.provider);
        const { data, error } = await admin
          .from('provider_credentials')
          .update({ enabled: body.enabled, updated_at: new Date().toISOString() })
          .eq('user_id', userId)
          .eq('provider', body.provider)
          .select('*')
          .maybeSingle();
        if (error) throw new ApiException('internal_error', `更新凭证失败：${error.message}`);
        if (!data) throw new ApiException('not_found', '凭证不存在');
        return ok<ProviderCredentialsResponse>({
          action: 'toggle',
          credential: rowToCredential(data as Record<string, unknown>),
        });
      }

      case 'delete': {
        if (!body.id) throw new ApiException('invalid_params', '缺少凭证标识');
        const { data, error } = await admin.rpc('delete_provider_credential', {
          p_user_id: userId,
          p_id: body.id,
        });
        if (error) throw new ApiException('internal_error', `删除凭证失败：${error.message}`);
        return ok<ProviderCredentialsResponse>({ action: 'delete', deleted: Boolean(data) });
      }

      case 'test': {
        assertProvider(body.provider);
        let apiKey = body.apiKey;
        let baseUrl = body.baseUrl ?? undefined;
        // 未传 Key：用已存的 Key 测试（仅在边缘内解密，不外泄）
        if (!apiKey) {
          const stored = await fetchStoredKey(admin, userId, body.provider);
          if (stored) {
            apiKey = stored.apiKey;
            if (baseUrl === undefined) baseUrl = stored.baseUrl ?? undefined;
          }
        }
        if (!apiKey) {
          return ok<ProviderCredentialsResponse>({
            action: 'test',
            result: { ok: false, message: '未提供密钥' },
          });
        }
        const result = await testProviderKey(body.provider, apiKey, baseUrl);
        return ok<ProviderCredentialsResponse>({ action: 'test', result });
      }

      default:
        return fail('invalid_params', '未知操作');
    }
  } catch (error) {
    return exceptionToResponse(error);
  }
});
