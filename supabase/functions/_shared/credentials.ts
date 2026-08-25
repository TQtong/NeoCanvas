/**
 * 提供商凭证解析（BYOK，第 05 篇第三节扩展）。
 *
 * 密钥解析单点：把「请求归属用户在某 provider 的凭证」解析为 `{ apiKey, baseUrl }`，供
 * `buildModelContext` 注入 {@link ModelContext.credentials}，适配器统一从上下文取用。
 *
 * 解析优先级：
 *   1. 用户凭证（启用）—— 经 `get_provider_api_key` RPC 从 Vault 解密（仅 service_role 可调）；
 *   2. 环境变量回退 —— 维持「以 env 提供全局默认 Key」的本地 / 部署可用性；
 *   3. 皆无 —— 以 `model_unavailable` 拒绝，提示在设置中配置或设置环境变量。
 *
 * 安全：明文 Key 只在边缘进程内存在，绝不写入客户端可读列、绝不下发前端。
 *
 * @module functions/_shared/credentials
 */

import { type BuiltInProvider, type Provider, type ProviderTestResult } from './types.ts';
import { type SupabaseClient } from './supabase.ts';
import { ApiException } from './response.ts';
import { requireTestProviderEnabled, TEST_PROVIDER } from './test-provider.ts';
import type { ResolvedAdapterProvider } from './adapters/registry.ts';

/** 各 provider 的环境变量回退名（无用户凭证时取）。与 docs/SETUP.md 一致。 */
export const PROVIDER_ENV: Partial<Record<BuiltInProvider, { key: string; baseUrl?: string }>> = {
  openai: { key: 'OPENAI_API_KEY' },
  google: { key: 'GOOGLE_API_KEY' },
  volcengine: { key: 'ARK_API_KEY' },
  fal: { key: 'FAL_API_KEY' },
  replicate: { key: 'REPLICATE_API_TOKEN' },
  siliconflow: { key: 'SILICONFLOW_API_KEY', baseUrl: 'SILICONFLOW_BASE_URL' },
  minimax: { key: 'MINIMAX_API_KEY' },
};

/** 解析结果：明文 Key 与可选自定义端点。 */
export interface ResolvedCredential {
  apiKey: string;
  baseUrl?: string;
}

/** 查询到的协议适配器，用于把自定义供应商实例路由到实际实现。 */
export async function resolveProviderAdapter(
  admin: SupabaseClient,
  provider: Provider,
  projectId: string,
): Promise<ResolvedAdapterProvider> {
  if (provider === TEST_PROVIDER) {
    requireTestProviderEnabled();
    return TEST_PROVIDER;
  }
  if (!provider.startsWith('custom:')) return provider as BuiltInProvider;
  const { data: project } = await admin
    .from('projects')
    .select('owner_id')
    .eq('id', projectId)
    .maybeSingle();
  const ownerId = project?.owner_id as string | undefined;
  if (ownerId) {
    const { data } = await admin
      .from('provider_credentials')
      .select('adapter, enabled')
      .eq('user_id', ownerId)
      .eq('provider', provider)
      .maybeSingle();
    if (data?.enabled && data.adapter) return data.adapter as BuiltInProvider;
  }
  throw new ApiException('model_unavailable', `${provider} 未找到可用的协议适配器`);
}

/** `get_provider_api_key` RPC 行形状。 */
interface ProviderKeyRow {
  api_key: string | null;
  base_url: string | null;
  enabled: boolean;
}

/** 生成阶段再次校验凭证端点，防止历史脏数据绕过写入校验形成 SSRF。 */
function safeBaseUrl(value: string | null): string | undefined {
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ApiException('invalid_params', '供应商 API 端点不是有效 URL');
  }
  const host = url.hostname.toLowerCase();
  const forbidden = host === 'localhost' ||
    host.endsWith('.local') ||
    host === '0.0.0.0' ||
    host === '127.0.0.1' ||
    host === '169.254.169.254' ||
    host === '::1' ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (url.protocol !== 'https:' || url.username || url.password || forbidden) {
    throw new ApiException('invalid_params', '供应商 API 端点必须是公网 HTTPS 地址');
  }
  return url.toString().replace(/\/$/, '');
}

/**
 * 解析某项目归属用户在某 provider 的凭证：用户凭证（启用）→ 环境变量回退。
 *
 * @param admin - 管理员客户端（service_role，可调凭证解密 RPC）
 * @param provider - 提供商
 * @param projectId - 项目（用于反查 owner）
 * @returns 已解析的 Key 与可选端点
 * @throws {ApiException} model_unavailable 当用户与环境变量均无可用 Key
 */
export async function resolveProviderCredential(
  admin: SupabaseClient,
  provider: Provider,
  projectId: string,
): Promise<ResolvedCredential> {
  if (provider === TEST_PROVIDER) {
    requireTestProviderEnabled();
    return { apiKey: 'deterministic-test-provider' };
  }
  // 1) 项目 → 归属用户
  const { data: project } = await admin
    .from('projects')
    .select('owner_id')
    .eq('id', projectId)
    .maybeSingle();
  const ownerId = (project?.owner_id as string | undefined) ?? undefined;

  // 2) 用户凭证（经 Vault 解密；仅启用且有 Key 才采用）
  if (ownerId) {
    const { data, error } = await admin.rpc('get_provider_api_key', {
      p_user_id: ownerId,
      p_provider: provider,
    });
    const row = (Array.isArray(data) ? data[0] : data) as ProviderKeyRow | null | undefined;
    if (!error && row && row.enabled && row.api_key) {
      return { apiKey: row.api_key, baseUrl: safeBaseUrl(row.base_url) };
    }
  }

  // 3) 环境变量回退
  const env = PROVIDER_ENV[provider as BuiltInProvider];
  if (!env) {
    throw new ApiException(
      'model_unavailable',
      `${provider} 未配置密钥：请在「设置 → 模型提供商」中配置并启用该供应商`,
    );
  }
  const apiKey = Deno.env.get(env.key);
  if (apiKey) {
    const baseUrl = env.baseUrl ? (Deno.env.get(env.baseUrl) ?? undefined) : undefined;
    return { apiKey, baseUrl };
  }

  throw new ApiException(
    'model_unavailable',
    `${provider} 未配置密钥：请在「设置 → 模型提供商」中配置，或设置环境变量 ${env.key}`,
  );
}

/**
 * 连通性测试：以传入的 Key / 端点对各 provider 做一次轻量探活，判断密钥是否被接受。
 *
 * 设计为 best-effort：能明确判定鉴权失败（401/403）即返回 ok=false；2xx 视为连通；其余
 * 网络 / 服务错误如实回报，不抛异常（测试不应让设置页崩溃）。
 *
 * @param provider - 提供商
 * @param apiKey - 待测 Key
 * @param baseUrl - 可选自定义端点
 */
export async function testProviderKey(
  provider: BuiltInProvider,
  apiKey: string,
  baseUrl?: string,
): Promise<ProviderTestResult> {
  try {
    if (provider === 'jimeng') {
      const credential = JSON.parse(apiKey) as {
        accessKeyId?: string;
        secretAccessKey?: string;
      };
      if (!credential.accessKeyId?.trim() || !credential.secretAccessKey?.trim()) {
        return { ok: false, message: 'Access Key ID 或 Secret Access Key 为空' };
      }
      const endpoint = new URL(baseUrl ?? 'https://visual.volcengineapi.com');
      if (endpoint.protocol !== 'https:') {
        return { ok: false, message: '即梦 API 端点必须使用 HTTPS' };
      }
      return { ok: true, message: 'AK/SK 格式有效，实际签名将在生成任务时验证' };
    }
    const probe = buildProbe(provider, apiKey, baseUrl);
    const response = await fetch(probe.url, { method: probe.method, headers: probe.headers });
    if (response.status === 401 || response.status === 403) {
      return { ok: false, status: response.status, message: '密钥被拒绝（鉴权失败）' };
    }
    if (response.ok) {
      return { ok: true, status: response.status };
    }
    if (response.status >= 400 && response.status < 500) {
      return { ok: true, status: response.status, message: '端点可达，鉴权未被明确拒绝' };
    }
    // 非鉴权类错误：端点可达但参数 / 资源问题，视为「Key 形态可用、未通过完整探活」
    const text = await response.text();
    return { ok: false, status: response.status, message: text.slice(0, 200) || '探活未通过' };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : '网络错误' };
  }
}

/** 各 provider 的探活请求构造（取最轻量、只读的鉴权端点）。 */
function buildProbe(
  provider: BuiltInProvider,
  apiKey: string,
  baseUrl?: string,
): { url: string; method: 'GET'; headers: Record<string, string> } {
  const trim = (u: string) => u.replace(/\/$/, '');
  switch (provider) {
    case 'openai':
      return {
        url: `${trim(baseUrl ?? 'https://api.openai.com/v1')}/models`,
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
      };
    case 'siliconflow':
      return {
        url: `${trim(baseUrl ?? 'https://api.siliconflow.cn/v1')}/models`,
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
      };
    case 'google':
      return {
        url: `${
          trim(baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta')
        }/models?key=${apiKey}`,
        method: 'GET',
        headers: {},
      };
    case 'replicate':
      return {
        url: `${trim(baseUrl ?? 'https://api.replicate.com/v1')}/account`,
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
      };
    case 'volcengine':
      return {
        url: `${trim(baseUrl ?? 'https://ark.cn-beijing.volces.com/api/v3')}/models`,
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
      };
    case 'fal':
      // fal 无公开的轻量账户端点：以队列基址做一次鉴权 GET，401/403 判定为密钥无效
      return {
        url: `${trim(baseUrl ?? 'https://queue.fal.run')}/`,
        method: 'GET',
        headers: { Authorization: `Key ${apiKey}` },
      };
    case 'minimax':
      return {
        url: `${trim(baseUrl ?? 'https://api.minimaxi.com/v1')}/image_generation`,
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
      };
    case 'jimeng':
      throw new Error('即梦使用专用 AK/SK 格式校验');
  }
}
