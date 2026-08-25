/**
 * 模型访问的唯一服务端判定入口。
 *
 * service-role 会绕过 RLS，因此所有生成入口必须显式限定“内置模型或当前用户自有模型”，
 * 并对 custom Provider 校验同一用户的启用凭据，不能仅凭全局唯一 key 取模型。
 *
 * @module functions/_shared/models
 */

import { ApiException } from './response.ts';
import { type SupabaseClient } from './supabase.ts';
import { type Modality, type ModelCatalogRow } from './types.ts';

/**
 * 读取当前用户可访问且启用的模型。
 *
 * @param admin - service-role 客户端
 * @param modelKey - 模型目录键
 * @param userId - 当前业务用户
 * @param modality - 可选的请求模态约束
 * @returns 已通过归属与凭据校验的模型行
 * @throws {ApiException} 模型不可访问或 custom Provider 凭据不可用
 */
export async function requireAccessibleModel(
  admin: SupabaseClient,
  modelKey: string,
  userId: string,
  modality?: Modality,
): Promise<ModelCatalogRow> {
  let query = admin
    .from('model_catalog')
    .select('*')
    .eq('key', modelKey)
    .eq('is_active', true)
    .or(`user_id.is.null,user_id.eq.${userId}`);
  if (modality) query = query.eq('modality', modality);

  const { data, error } = await query.maybeSingle();
  if (error) {
    throw new ApiException('internal_error', `读取模型目录失败：${error.message}`);
  }
  if (!data) {
    throw new ApiException('model_not_accessible', '模型不可用、模态不匹配或不属于当前用户');
  }

  const model = data as ModelCatalogRow;
  if (model.provider.startsWith('custom:')) {
    const { data: credential, error: credentialError } = await admin
      .from('provider_credentials')
      .select('id')
      .eq('user_id', userId)
      .eq('provider', model.provider)
      .eq('enabled', true)
      .maybeSingle();
    if (credentialError) {
      throw new ApiException('internal_error', `读取模型凭据失败：${credentialError.message}`);
    }
    if (!credential) {
      throw new ApiException('model_not_accessible', '自定义模型的 Provider 凭据未配置或已停用');
    }
  }
  return model;
}

/**
 * 列出当前用户真正可执行的活跃模型，供 Agent 跨模态选型。
 *
 * @param admin - service-role 客户端
 * @param userId - 当前业务用户
 * @param modality - 可选模态过滤
 * @returns 已按 sort_order 排序并过滤无凭据 custom Provider 的目录行
 */
export async function listAccessibleModels(
  admin: SupabaseClient,
  userId: string,
  modality?: Modality,
): Promise<ModelCatalogRow[]> {
  let query = admin
    .from('model_catalog')
    .select('*')
    .eq('is_active', true)
    .or(`user_id.is.null,user_id.eq.${userId}`)
    .order('sort_order', { ascending: true });
  if (modality) query = query.eq('modality', modality);
  const { data, error } = await query;
  if (error) {
    throw new ApiException('internal_error', `读取模型目录失败：${error.message}`);
  }

  const rows = (data ?? []) as ModelCatalogRow[];
  const customProviders = Array.from(
    new Set(rows.map((row) => row.provider).filter((provider) => provider.startsWith('custom:'))),
  );
  if (customProviders.length === 0) return rows;

  const { data: credentials, error: credentialError } = await admin
    .from('provider_credentials')
    .select('provider')
    .eq('user_id', userId)
    .eq('enabled', true)
    .in('provider', customProviders);
  if (credentialError) {
    throw new ApiException('internal_error', `读取模型凭据失败：${credentialError.message}`);
  }
  const enabled = new Set((credentials ?? []).map((row) => row.provider as string));
  return rows.filter(
    (row) => !row.provider.startsWith('custom:') || enabled.has(row.provider),
  );
}
