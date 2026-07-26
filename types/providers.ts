/**
 * 模型提供商凭证（BYOK）契约。
 *
 * 用户在前端自助配置「模型提供商 + API Key」。明文 Key 永不下发客户端：库表与本契约
 * 只承载脱敏元数据（provider / base_url / 尾号 / 启停）。写入与连通性测试经
 * `provider-credentials` Edge Function（service_role + Vault），读取列表经 RLS 直查。
 *
 * @module types/providers
 */

import type { BuiltInProvider, Provider } from './enums';

/**
 * 前端消费的提供商凭证视图（脱敏）。由 `provider_credentials` 行映射，**不含明文 Key**。
 */
export interface ProviderCredential {
  /** 凭证标识。 */
  id: string;
  /** 提供商。 */
  provider: Provider;
  /** 实际调用的协议适配器。内置提供商与 provider 相同，自定义提供商由用户选择。 */
  adapter: BuiltInProvider;
  /** 可选展示标签。 */
  label: string | null;
  /** 提供商官网，仅用于设置页展示与跳转。 */
  websiteUrl: string | null;
  /** 可选自定义端点（OpenAI 兼容代理 / 自建网关）。 */
  baseUrl: string | null;
  /** Key 末 4 位，用于「••••abcd」展示。 */
  keyLast4: string;
  /** 是否启用（停用则解析时跳过、回退环境变量）。 */
  enabled: boolean;
  /** 创建时间（ISO）。 */
  createdAt: string;
  /** 更新时间（ISO）。 */
  updatedAt: string;
}

/**
 * `provider_credentials` 表行（snake_case，与列名逐字一致）。
 * 注意：**无明文 Key 列**；`key_secret_id` 仅为 vault 引用，客户端无法解密。
 */
export type ProviderCredentialRow = {
  id: string;
  user_id: string;
  provider: Provider;
  adapter: BuiltInProvider;
  label: string | null;
  website_url: string | null;
  base_url: string | null;
  key_last4: string;
  key_secret_id: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

/**
 * provider-credentials 请求：以 `action` 判别的联合。
 *
 * - `save`：新建 / 覆盖凭证（`apiKey` 为空表示沿用既有 Key，仅改 base_url / enabled）。
 * - `toggle`：启停既有凭证。
 * - `delete`：删除凭证（连同 Vault 机密）。
 * - `test`：连通性测试（用传入的 `apiKey`，或留空则用已存 Key）。
 */
export type ProviderCredentialsRequest =
  | {
      action: 'save';
      provider: Provider;
      adapter?: BuiltInProvider;
      apiKey?: string;
      /** 需要双密钥认证的提供商（当前为即梦）的 Secret Access Key。 */
      apiSecret?: string;
      baseUrl?: string | null;
      label?: string | null;
      websiteUrl?: string | null;
      enabled?: boolean;
    }
  | { action: 'toggle'; provider: Provider; enabled: boolean }
  | { action: 'delete'; id: string }
  | {
      action: 'test';
      provider: Provider;
      adapter?: BuiltInProvider;
      apiKey?: string;
      apiSecret?: string;
      baseUrl?: string | null;
    };

/** 连通性测试结果。 */
export interface ProviderTestResult {
  /** 是否连通（密钥被提供商接受）。 */
  ok: boolean;
  /** 探活的 HTTP 状态（如有）。 */
  status?: number;
  /** 失败时的简短说明。 */
  message?: string;
}

/**
 * provider-credentials 响应：随 `action` 不同而不同。
 * save / toggle 回脱敏凭证；delete 回是否删除；test 回连通结果。
 */
export type ProviderCredentialsResponse =
  | { action: 'save'; credential: ProviderCredential }
  | { action: 'toggle'; credential: ProviderCredential }
  | { action: 'delete'; deleted: boolean }
  | { action: 'test'; result: ProviderTestResult };
