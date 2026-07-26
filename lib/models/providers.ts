/**
 * 模型提供商展示元数据。
 *
 * 提供商字面量仍以 `types/enums.ts` 为唯一契约；本文件只维护稳定的品牌展示顺序、名称与
 * 凭据占位提示，供设置页和节点模型选择器复用。
 *
 * @module lib/models/providers
 */

import type { BuiltInProvider, Provider, ProviderCredential } from '@/types';
import { isCustomProvider } from '@/types';

/** 提供商展示定义。 */
export interface ProviderDefinition {
  /** 适配器路由标识。 */
  id: Provider;
  /** 请求协议适配器。 */
  adapter: BuiltInProvider;
  /** 品牌名称。 */
  name: string;
  /** 紧凑品牌标记。 */
  mark: string;
  /** 品牌标记配色。 */
  markClassName: string;
  /** 本地化描述文案键。 */
  descriptionKey: string;
  /** API Key 输入占位。 */
  apiKeyPlaceholder: string;
  /** 官方 API 基础地址；凭据未配置自定义地址时自动回填。 */
  officialBaseUrl: string;
  /** 官方网站或开放平台。 */
  websiteUrl: string;
  /** 凭证字段形态。 */
  authMode: 'api-key' | 'access-key-pair';
  /** 是否由用户创建。 */
  isCustom?: boolean;
}

/** 设置页与模型分组的展示顺序。 */
export const PROVIDER_DEFINITIONS: readonly ProviderDefinition[] = [
  {
    id: 'volcengine',
    adapter: 'volcengine',
    name: '火山方舟 Ark',
    mark: '火',
    markClassName: 'bg-[#1664ff] text-white',
    descriptionKey: 'providers.volcengineDescription',
    apiKeyPlaceholder: '输入火山方舟 API Key',
    officialBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    websiteUrl: 'https://www.volcengine.com/product/ark',
    authMode: 'api-key',
  },
  {
    id: 'jimeng',
    adapter: 'jimeng',
    name: '即梦 AI',
    mark: '梦',
    markClassName: 'bg-[#6c5ce7] text-white',
    descriptionKey: 'providers.jimengDescription',
    apiKeyPlaceholder: 'Access Key ID',
    officialBaseUrl: 'https://visual.volcengineapi.com',
    websiteUrl: 'https://www.volcengine.com/product/jimeng',
    authMode: 'access-key-pair',
  },
  {
    id: 'siliconflow',
    adapter: 'siliconflow',
    name: '硅基流动 SiliconFlow',
    mark: 'S',
    markClassName: 'bg-[#16a085] text-white',
    descriptionKey: 'providers.siliconflowDescription',
    apiKeyPlaceholder: 'sk-...',
    officialBaseUrl: 'https://api.siliconflow.cn/v1',
    websiteUrl: 'https://siliconflow.cn',
    authMode: 'api-key',
  },
  {
    id: 'minimax',
    adapter: 'minimax',
    name: 'MiniMax',
    mark: 'M',
    markClassName: 'bg-[#f04438] text-white',
    descriptionKey: 'providers.minimaxDescription',
    apiKeyPlaceholder: '输入 MiniMax API Key',
    officialBaseUrl: 'https://api.minimaxi.com/v1',
    websiteUrl: 'https://platform.minimaxi.com',
    authMode: 'api-key',
  },
  {
    id: 'openai',
    adapter: 'openai',
    name: 'OpenAI',
    mark: 'AI',
    markClassName: 'bg-foreground text-background',
    descriptionKey: 'providers.openaiDescription',
    apiKeyPlaceholder: 'sk-...',
    officialBaseUrl: 'https://api.openai.com/v1',
    websiteUrl: 'https://platform.openai.com',
    authMode: 'api-key',
  },
  {
    id: 'google',
    adapter: 'google',
    name: 'Google Gemini',
    mark: 'G',
    markClassName: 'bg-[#4285f4] text-white',
    descriptionKey: 'providers.googleDescription',
    apiKeyPlaceholder: 'AIza...',
    officialBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    websiteUrl: 'https://ai.google.dev',
    authMode: 'api-key',
  },
  {
    id: 'fal',
    adapter: 'fal',
    name: 'fal.ai',
    mark: 'fal',
    markClassName: 'bg-[#f4d35e] text-[#18181b]',
    descriptionKey: 'providers.falDescription',
    apiKeyPlaceholder: '输入 fal.ai API Key',
    officialBaseUrl: 'https://queue.fal.run',
    websiteUrl: 'https://fal.ai',
    authMode: 'api-key',
  },
  {
    id: 'replicate',
    adapter: 'replicate',
    name: 'Replicate',
    mark: 'R',
    markClassName: 'bg-[#ff6b35] text-white',
    descriptionKey: 'providers.replicateDescription',
    apiKeyPlaceholder: 'r8_...',
    officialBaseUrl: 'https://api.replicate.com/v1',
    websiteUrl: 'https://replicate.com',
    authMode: 'api-key',
  },
] as const;

/** 按适配器标识索引的提供商展示定义。 */
export const PROVIDER_DEFINITION_BY_ID: Readonly<Record<BuiltInProvider, ProviderDefinition>> =
  Object.fromEntries(
    PROVIDER_DEFINITIONS.map((definition) => [definition.id, definition]),
  ) as Record<BuiltInProvider, ProviderDefinition>;

/** 由自定义凭证生成与内置供应商一致的展示定义。 */
export function customProviderDefinition(credential: ProviderCredential): ProviderDefinition {
  const name = credential.label?.trim() || '自定义供应商';
  return {
    id: credential.provider,
    adapter: credential.adapter,
    name,
    mark: name.slice(0, 1).toUpperCase(),
    markClassName: 'bg-muted text-foreground',
    descriptionKey: 'providers.customDescription',
    apiKeyPlaceholder: '输入 API Key',
    officialBaseUrl: credential.baseUrl ?? '',
    websiteUrl: credential.websiteUrl ?? '',
    authMode: credential.adapter === 'jimeng' ? 'access-key-pair' : 'api-key',
    isCustom: true,
  };
}

/** 按实例标识解析内置或用户自定义供应商定义。 */
export function providerDefinition(
  provider: Provider,
  credentials: ProviderCredential[],
): ProviderDefinition | undefined {
  if (!isCustomProvider(provider)) {
    return PROVIDER_DEFINITION_BY_ID[provider];
  }
  const credential = credentials.find((item) => item.provider === provider);
  return credential ? customProviderDefinition(credential) : undefined;
}
