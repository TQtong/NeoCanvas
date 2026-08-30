/**
 * 浏览器侧 Provider 图片操作协议能力。
 *
 * 该清单必须与 Edge Adapter 的 `supportedOperations` 逐字同步。模型选择器最终取协议能力、
 * 模型目录能力和启用凭据三者交集；自定义 Provider 使用其凭据声明的兼容协议，不能通过
 * 模型目录扩大底层能力。
 *
 * @module lib/models/image-operation-capabilities
 */

import type {
  BuiltInProvider,
  ImageOperation,
  ModelCatalogEntry,
  ProviderCredential,
} from '@/types';
import { isCustomProvider, modelSupportsImageOperation } from '@/types';

/** 与当前已实现 Adapter 一致的保守协议能力。 */
export const ADAPTER_IMAGE_OPERATIONS: Readonly<
  Record<BuiltInProvider, readonly ImageOperation[]>
> = {
  openai: ['generate', 'semantic_edit'],
  google: ['generate', 'semantic_edit'],
  volcengine: ['generate'],
  jimeng: ['generate', 'semantic_edit'],
  minimax: ['generate', 'semantic_edit'],
  fal: ['generate', 'semantic_edit'],
  replicate: ['generate', 'semantic_edit'],
  siliconflow: ['generate', 'semantic_edit'],
};

/** 解析一个 Provider 实例实际使用的协议适配器。 */
export function adapterForModel(
  model: ModelCatalogEntry,
  credentials: ProviderCredential[],
): BuiltInProvider | null {
  if (!isCustomProvider(model.provider)) return model.provider;
  return (
    credentials.find((credential) => credential.provider === model.provider && credential.enabled)
      ?.adapter ?? null
  );
}

/** 判断模型是否同时满足上架、图片模态、凭据、目录与协议能力。 */
export function isModelAvailableForImageOperation(
  model: ModelCatalogEntry,
  credentials: ProviderCredential[],
  operation: ImageOperation,
): boolean {
  if (!model.isActive || model.modality !== 'image') return false;
  const credential = credentials.find(
    (candidate) => candidate.provider === model.provider && candidate.enabled,
  );
  if (!credential) return false;
  const adapter = adapterForModel(model, credentials);
  return Boolean(
    adapter &&
    ADAPTER_IMAGE_OPERATIONS[adapter].includes(operation) &&
    modelSupportsImageOperation(model.capabilities, operation),
  );
}

/** 返回按目录顺序排列的可用操作模型。 */
export function modelsForImageOperation(
  models: ModelCatalogEntry[],
  credentials: ProviderCredential[],
  operation: ImageOperation,
): ModelCatalogEntry[] {
  return models.filter((model) => isModelAvailableForImageOperation(model, credentials, operation));
}
