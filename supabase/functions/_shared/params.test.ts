import { assertEquals, assertThrows } from 'jsr:@std/assert@1';
import { validateParams } from './pipeline.ts';
import { buildGenerationParams } from './params.ts';
import { ApiException } from './response.ts';
import { type ModelCapabilities, type UnifiedGenerationRequest } from './types.ts';

const capabilities: ModelCapabilities = {
  imageOperations: ['generate'],
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

/** 构造支持精准编辑的完整能力画像。 */
function editCapabilities(
  imageOperations: ModelCapabilities['imageOperations'],
): ModelCapabilities {
  return {
    ...capabilities,
    imageOperations,
    maxOutputs: 4,
    supportsReferenceImages: true,
    maxInputImages: 2,
    inputFidelityOptions: ['standard', 'high'],
    upscaleFactors: [2, 4],
    supportsTransparentOutput: true,
  };
}

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
  validateParams(capabilities, request, ['generate']);
  if (request.params.modality !== 'image') throw new Error('测试请求模态错误');
  assertEquals(request.params.count, 2);
  assertEquals(request.params.quality, undefined);
  assertEquals(request.params.seed, undefined);
});

Deno.test('模型默认图片尺寸完整进入首次生成请求', () => {
  assertEquals(
    buildGenerationParams(
      'image',
      {
        aspectRatio: '1:1',
        width: 320,
        height: 240,
        sizePreset: 'custom',
        count: 2,
        quality: 'high',
      },
      [],
    ),
    {
      modality: 'image',
      aspectRatio: '1:1',
      width: 320,
      height: 240,
      sizePreset: 'custom',
      count: 2,
      quality: 'high',
      references: [],
    },
  );
});

Deno.test('模型能力校验拒绝不支持的比例与参考图', () => {
  const ratio = imageRequest();
  if (ratio.params.modality !== 'image') throw new Error('测试请求模态错误');
  ratio.params.aspectRatio = '3:4';
  assertThrows(() => validateParams(capabilities, ratio, ['generate']), ApiException);

  const reference = imageRequest();
  reference.params.references = [
    { origin: 'attachment', assetId: 'asset-1', role: 'content' },
  ];
  assertThrows(() => validateParams(capabilities, reference, ['generate']), ApiException);
});

Deno.test('旧图片参考请求在幂等计算前规范化为语义编辑', () => {
  const request = imageRequest();
  if (request.params.modality !== 'image') throw new Error('测试请求模态错误');
  request.params.count = 2;
  request.params.references = [
    { origin: 'attachment', assetId: 'asset-content', role: 'content' },
  ];
  validateParams(editCapabilities(['semantic_edit']), request, ['semantic_edit']);
  assertEquals(request.params.operation, 'semantic_edit');
});

Deno.test('精准编辑同时受模型与适配器操作能力约束', () => {
  const request = imageRequest();
  if (request.params.modality !== 'image') throw new Error('测试请求模态错误');
  request.params = {
    modality: 'image',
    operation: 'semantic_edit',
    inputMode: 'original',
    count: 1,
    references: [{ origin: 'attachment', assetId: 'asset-content', role: 'content' }],
  };
  const error = assertThrows(
    () => validateParams(editCapabilities(['semantic_edit']), request, ['generate']),
    ApiException,
  );
  assertEquals(error.details?.reason, 'unsupported_image_operation');
});

Deno.test('局部重绘校验唯一源图、唯一蒙版与羽化范围', () => {
  const request = imageRequest();
  request.params = {
    modality: 'image',
    operation: 'inpaint',
    inputMode: 'flattened',
    count: 3,
    maskFeatherPx: 32,
    references: [
      { origin: 'attachment', assetId: 'asset-content', role: 'content' },
      { origin: 'attachment', assetId: 'asset-mask', role: 'mask' },
    ],
  };
  validateParams(editCapabilities(['inpaint']), request, ['inpaint']);

  if (request.params.modality !== 'image' || request.params.operation !== 'inpaint') {
    throw new Error('测试请求操作错误');
  }
  request.params.maskFeatherPx = 129;
  assertThrows(
    () => validateParams(editCapabilities(['inpaint']), request, ['inpaint']),
    ApiException,
  );
});

Deno.test('扩图画布必须完整容纳源图', () => {
  const request = imageRequest();
  request.params = {
    modality: 'image',
    operation: 'outpaint',
    inputMode: 'original',
    count: 1,
    references: [{ origin: 'attachment', assetId: 'asset-content', role: 'content' }],
    outputCanvas: {
      width: 1536,
      height: 1024,
      sourceX: 256,
      sourceY: 0,
      sourceWidth: 1024,
      sourceHeight: 1024,
    },
  };
  validateParams(editCapabilities(['outpaint']), request, ['outpaint']);

  if (request.params.modality !== 'image' || request.params.operation !== 'outpaint') {
    throw new Error('测试请求操作错误');
  }
  request.params.outputCanvas.sourceX = 600;
  const error = assertThrows(
    () => validateParams(editCapabilities(['outpaint']), request, ['outpaint']),
    ApiException,
  );
  assertEquals(error.details?.reason, 'output_canvas_invalid');
});

Deno.test('去背景与高清放大执行确定性输出约束', () => {
  const removeRequest = imageRequest();
  removeRequest.params = {
    modality: 'image',
    operation: 'remove_background',
    inputMode: 'original',
    background: 'transparent',
    count: 1,
    references: [{ origin: 'attachment', assetId: 'asset-content', role: 'content' }],
  };
  validateParams(
    editCapabilities(['remove_background']),
    removeRequest,
    ['remove_background'],
  );

  const upscaleRequest = imageRequest();
  upscaleRequest.params = {
    modality: 'image',
    operation: 'upscale',
    inputMode: 'original',
    upscaleFactor: 4,
    count: 1,
    references: [{ origin: 'attachment', assetId: 'asset-content', role: 'content' }],
  };
  validateParams(editCapabilities(['upscale']), upscaleRequest, ['upscale']);

  if (upscaleRequest.params.modality !== 'image' || upscaleRequest.params.operation !== 'upscale') {
    throw new Error('测试请求操作错误');
  }
  upscaleRequest.params.upscaleFactor = 4;
  const unsupported = editCapabilities(['upscale']);
  unsupported.upscaleFactors = [2];
  const error = assertThrows(
    () => validateParams(unsupported, upscaleRequest, ['upscale']),
    ApiException,
  );
  assertEquals(error.details?.reason, 'upscale_factor_unsupported');
});
