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

/** 只在受控本地 E2E 环境启用的确定性 Provider，与 Edge 守卫逐字一致。 */
const TEST_PROVIDER = 'custom:neocanvas-test';
/** 确定性 Provider 覆盖全部图片操作，用于验证正式 UI 与事务链路。 */
const TEST_PROVIDER_IMAGE_OPERATIONS: readonly ImageOperation[] = [
  'generate',
  'semantic_edit',
  'inpaint',
  'outpaint',
  'remove_background',
  'upscale',
];

/** 与当前已实现 Adapter 一致的保守协议能力。 */
export const ADAPTER_IMAGE_OPERATIONS: Readonly<
  Record<BuiltInProvider, readonly ImageOperation[]>
> = {
  openai: ['generate', 'semantic_edit', 'inpaint', 'outpaint'],
  google: ['generate', 'semantic_edit'],
  volcengine: ['generate', 'semantic_edit'],
  jimeng: ['generate', 'semantic_edit', 'inpaint', 'outpaint', 'remove_background', 'upscale'],
  minimax: ['generate', 'semantic_edit'],
  fal: ['inpaint', 'remove_background', 'upscale'],
  replicate: ['inpaint', 'remove_background', 'upscale'],
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
  // 测试 Provider 在 Edge 侧还会再次检查 NEOCANVAS_TEST_MODE；公开构建未显式开启时
  // 必须继续按自定义 Provider 的真实 adapter 能力收紧，不能形成生产后门。
  if (
    model.provider === TEST_PROVIDER &&
    process.env.NEXT_PUBLIC_NEOCANVAS_TEST_MODE === 'true'
  ) {
    return (
      TEST_PROVIDER_IMAGE_OPERATIONS.includes(operation) &&
      modelSupportsImageOperation(model.capabilities, operation)
    );
  }
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
