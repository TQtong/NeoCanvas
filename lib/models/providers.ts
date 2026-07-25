/**
 * 模型提供商展示元数据。
 *
 * 提供商字面量仍以 `types/enums.ts` 为唯一契约；本文件只维护稳定的品牌展示顺序、名称与
 * 凭据占位提示，供设置页和节点模型选择器复用。
 *
 * @module lib/models/providers
 */

import type { Provider } from '@/types';

/** 提供商展示定义。 */
export interface ProviderDefinition {
  /** 适配器路由标识。 */
  id: Provider;
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
}

/** 设置页与模型分组的展示顺序。 */
export const PROVIDER_DEFINITIONS: readonly ProviderDefinition[] = [
  {
    id: 'volcengine',
    name: '火山方舟 Ark',
    mark: '火',
    markClassName: 'bg-[#1664ff] text-white',
    descriptionKey: 'providers.volcengineDescription',
    apiKeyPlaceholder: '输入火山方舟 API Key',
    officialBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
  },
  {
    id: 'siliconflow',
    name: '硅基流动 SiliconFlow',
    mark: 'S',
    markClassName: 'bg-[#16a085] text-white',
    descriptionKey: 'providers.siliconflowDescription',
    apiKeyPlaceholder: 'sk-...',
    officialBaseUrl: 'https://api.siliconflow.cn/v1',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    mark: 'AI',
    markClassName: 'bg-foreground text-background',
    descriptionKey: 'providers.openaiDescription',
    apiKeyPlaceholder: 'sk-...',
    officialBaseUrl: 'https://api.openai.com/v1',
  },
  {
    id: 'google',
    name: 'Google Gemini',
    mark: 'G',
    markClassName: 'bg-[#4285f4] text-white',
    descriptionKey: 'providers.googleDescription',
    apiKeyPlaceholder: 'AIza...',
    officialBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  },
  {
    id: 'fal',
    name: 'fal.ai',
    mark: 'fal',
    markClassName: 'bg-[#f4d35e] text-[#18181b]',
    descriptionKey: 'providers.falDescription',
    apiKeyPlaceholder: '输入 fal.ai API Key',
    officialBaseUrl: 'https://queue.fal.run',
  },
  {
    id: 'replicate',
    name: 'Replicate',
    mark: 'R',
    markClassName: 'bg-[#ff6b35] text-white',
    descriptionKey: 'providers.replicateDescription',
    apiKeyPlaceholder: 'r8_...',
    officialBaseUrl: 'https://api.replicate.com/v1',
  },
] as const;

/** 按适配器标识索引的提供商展示定义。 */
export const PROVIDER_DEFINITION_BY_ID: Readonly<Record<Provider, ProviderDefinition>> =
  Object.fromEntries(
    PROVIDER_DEFINITIONS.map((definition) => [definition.id, definition]),
  ) as Record<Provider, ProviderDefinition>;
