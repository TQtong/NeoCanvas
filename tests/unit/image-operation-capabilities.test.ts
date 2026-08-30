import { describe, expect, it } from 'vitest';
import type { ModelCatalogEntry, ProviderCredential } from '@/types';
import {
  adapterForModel,
  isModelAvailableForImageOperation,
  modelsForImageOperation,
} from '@/lib/models/image-operation-capabilities';

const baseModel: ModelCatalogEntry = {
  key: 'image-model',
  displayName: 'Image model',
  provider: 'openai',
  modality: 'image',
  capabilities: {
    imageOperations: ['generate', 'semantic_edit', 'inpaint'],
    aspectRatios: ['1:1'],
    sizes: [],
    maxOutputs: 4,
    supportsNegativePrompt: false,
    supportsReferenceImages: true,
    supportsImageToVideo: false,
    supportsSeed: false,
    qualities: ['auto'],
    isAsync: false,
    supportsWebhook: false,
  },
  defaultParams: {},
  sortOrder: 1,
  isActive: true,
  userId: null,
};

function credential(
  provider: ProviderCredential['provider'],
  adapter: ProviderCredential['adapter'] = 'openai',
  enabled = true,
): ProviderCredential {
  return {
    id: `credential-${provider}`,
    provider,
    adapter,
    label: null,
    websiteUrl: null,
    baseUrl: null,
    keyLast4: '1234',
    enabled,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

describe('图片操作模型三方能力交集', () => {
  it('目录声明不能扩大 Adapter 尚未实现的操作', () => {
    const credentials = [credential('openai')];
    expect(isModelAvailableForImageOperation(baseModel, credentials, 'semantic_edit')).toBe(true);
    expect(isModelAvailableForImageOperation(baseModel, credentials, 'inpaint')).toBe(true);
    expect(isModelAvailableForImageOperation(baseModel, credentials, 'remove_background')).toBe(
      false,
    );
  });

  it('缺少或停用凭据时模型失败关闭', () => {
    expect(isModelAvailableForImageOperation(baseModel, [], 'semantic_edit')).toBe(false);
    expect(
      isModelAvailableForImageOperation(
        baseModel,
        [credential('openai', 'openai', false)],
        'semantic_edit',
      ),
    ).toBe(false);
  });

  it('自定义 Provider 使用凭据声明的底层协议能力', () => {
    const customModel: ModelCatalogEntry = {
      ...baseModel,
      key: 'custom-model',
      provider: 'custom:studio',
    };
    const credentials = [credential('custom:studio', 'volcengine')];
    expect(adapterForModel(customModel, credentials)).toBe('volcengine');
    expect(modelsForImageOperation([customModel], credentials, 'generate')).toEqual([customModel]);
    expect(modelsForImageOperation([customModel], credentials, 'semantic_edit')).toEqual([
      customModel,
    ]);
    expect(modelsForImageOperation([customModel], credentials, 'inpaint')).toEqual([]);
  });

  it('fal 与 Replicate 工具模型只开放已实现的操作集合', () => {
    const falModel: ModelCatalogEntry = {
      ...baseModel,
      provider: 'fal',
      capabilities: {
        ...baseModel.capabilities,
        imageOperations: ['remove_background', 'outpaint'],
      },
    };
    expect(
      isModelAvailableForImageOperation(falModel, [credential('fal', 'fal')], 'remove_background'),
    ).toBe(true);
    expect(
      isModelAvailableForImageOperation(falModel, [credential('fal', 'fal')], 'outpaint'),
    ).toBe(false);

    const replicateModel: ModelCatalogEntry = {
      ...baseModel,
      provider: 'replicate',
      capabilities: { ...baseModel.capabilities, imageOperations: ['generate', 'upscale'] },
    };
    const credentials = [credential('replicate', 'replicate')];
    expect(isModelAvailableForImageOperation(replicateModel, credentials, 'generate')).toBe(false);
    expect(isModelAvailableForImageOperation(replicateModel, credentials, 'upscale')).toBe(true);
  });
});
