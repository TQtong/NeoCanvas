import { assertEquals, assertThrows } from 'jsr:@std/assert@1';
import { validateParams } from './pipeline.ts';
import { ApiException } from './response.ts';
import { type ModelCapabilities, type UnifiedGenerationRequest } from './types.ts';

const capabilities: ModelCapabilities = {
  aspectRatios: ['1:1', '16:9'],
  sizes: [],
  maxOutputs: 2,
  supportsNegativePrompt: true,
  supportsReferenceImages: false,
  supportsImageToVideo: false,
  supportsSeed: false,
  qualities: ['auto', 'high'],
  isAsync: false,
  supportsWebhook: false,
};

function imageRequest(): UnifiedGenerationRequest {
  return {
    projectId: 'project-1',
    conversationId: null,
    messageId: null,
    modality: 'image',
    modelKey: 'test',
    prompt: 'test',
    idempotencyKey: 'key',
    params: {
      modality: 'image',
      count: 8,
      quality: 'medium',
      seed: 42,
      aspectRatio: '1:1',
      references: [],
    },
  };
}

Deno.test('模型能力校验对可降级参数确定性降级', () => {
  const request = imageRequest();
  validateParams(capabilities, request);
  if (request.params.modality !== 'image') throw new Error('测试请求模态错误');
  assertEquals(request.params.count, 2);
  assertEquals(request.params.quality, undefined);
  assertEquals(request.params.seed, undefined);
});

Deno.test('模型能力校验拒绝不支持的比例与参考图', () => {
  const ratio = imageRequest();
  if (ratio.params.modality !== 'image') throw new Error('测试请求模态错误');
  ratio.params.aspectRatio = '3:4';
  assertThrows(() => validateParams(capabilities, ratio), ApiException);

  const reference = imageRequest();
  reference.params.references = [
    { origin: 'attachment', assetId: 'asset-1', role: 'content' },
  ];
  assertThrows(() => validateParams(capabilities, reference), ApiException);
});
