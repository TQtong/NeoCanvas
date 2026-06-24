/**
 * 适配器注册表 / 路由器（第 05 篇第二节）。
 *
 * 依请求中的 provider 选取对应适配器实例。新增模型即「实现一个适配器 + 在此登记 +
 * 在 model_catalog 追加一行」，核心流水线零改动。
 *
 * @module functions/_shared/adapters/registry
 */

import { type Provider } from '../types.ts';
import { ApiException } from '../response.ts';
import { type ModelAdapter } from './base.ts';
import { openaiAdapter } from './openai.ts';
import { googleAdapter } from './google.ts';
import { volcengineAdapter } from './volcengine.ts';
import { falAdapter } from './fal.ts';
import { replicateAdapter } from './replicate.ts';
import { siliconflowAdapter } from './siliconflow.ts';

/** 提供商 → 适配器。 */
const REGISTRY: Record<Provider, ModelAdapter> = {
  openai: openaiAdapter,
  google: googleAdapter,
  volcengine: volcengineAdapter,
  fal: falAdapter,
  replicate: replicateAdapter,
  siliconflow: siliconflowAdapter,
};

/**
 * 按提供商取适配器。
 *
 * @param provider - 提供商标识
 * @returns 对应适配器
 * @throws {ApiException} 未知提供商（model_unavailable）
 */
export function getAdapter(provider: Provider): ModelAdapter {
  const adapter = REGISTRY[provider];
  if (!adapter) {
    throw new ApiException('model_unavailable', `未知提供商：${provider}`);
  }
  return adapter;
}
