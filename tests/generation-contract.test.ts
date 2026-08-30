/**
 * 图片操作共享契约测试。
 *
 * 验证前端读取的根类型辅助函数与 Edge 生成契约采用一致的保守能力语义。
 */

import { describe, expect, it } from 'vitest';
import {
  isImageEditOperation,
  modelSupportsImageOperation,
  normalizeImageOperation,
  type ModelCapabilities,
} from '@/types';

const capabilities: ModelCapabilities = {
  imageOperations: ['generate', 'semantic_edit'],
  aspectRatios: ['1:1'],
  sizes: [],
  maxOutputs: 2,
  supportsNegativePrompt: false,
  supportsReferenceImages: true,
  supportsImageToVideo: false,
  supportsSeed: false,
  qualities: ['auto'],
  isAsync: false,
  supportsWebhook: false,
};

describe('图片操作共享契约', () => {
  it('按旧请求的参考素材规范化操作', () => {
    expect(normalizeImageOperation({ modality: 'image', count: 1, references: [] })).toBe(
      'generate',
    );
    expect(
      normalizeImageOperation({
        modality: 'image',
        count: 1,
        references: [{ origin: 'attachment', assetId: 'asset-1', role: 'content' }],
      }),
    ).toBe('semantic_edit');
  });

  it('只把模型明确声明的操作视为可用', () => {
    expect(modelSupportsImageOperation(capabilities, 'generate')).toBe(true);
    expect(modelSupportsImageOperation(capabilities, 'semantic_edit')).toBe(true);
    expect(modelSupportsImageOperation(capabilities, 'inpaint')).toBe(false);
  });

  it('区分普通生成与非破坏图片编辑', () => {
    expect(isImageEditOperation('generate')).toBe(false);
    expect(isImageEditOperation('outpaint')).toBe(true);
    expect(isImageEditOperation('remove_background')).toBe(true);
  });
});
