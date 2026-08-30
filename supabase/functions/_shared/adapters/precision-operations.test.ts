import { assert, assertEquals } from 'jsr:@std/assert@1';
import type { ModelCapabilities, UnifiedGenerationRequest } from '../types.ts';
import type { ModelContext } from './base.ts';
import { openaiAdapter } from './openai.ts';
import { volcengineAdapter } from './volcengine.ts';

/** 构造适配器契约测试所需的最小完整图片能力。 */
function capabilities(operations: ModelCapabilities['imageOperations']): ModelCapabilities {
  return {
    imageOperations: operations,
    aspectRatios: ['1:1', '3:2', '2:3'],
    sizes: [],
    maxOutputs: 4,
    supportsNegativePrompt: false,
    supportsReferenceImages: true,
    supportsImageToVideo: false,
    supportsSeed: true,
    qualities: ['low', 'medium', 'high', 'auto'],
    isAsync: false,
    supportsWebhook: false,
    maxInputImages: 4,
    inputFidelityOptions: ['standard', 'high'],
  };
}

/** 构造共享 Provider 上下文。 */
function context(providerModel: string): ModelContext {
  return {
    modelKey: 'contract-test',
    providerModel,
    capabilities: capabilities(['semantic_edit', 'inpaint', 'outpaint']),
    references: [],
    keyframes: [],
    credentials: { apiKey: 'test-key' },
  };
}

/** 构造图片编辑请求外壳。 */
function request(params: UnifiedGenerationRequest['params']): UnifiedGenerationRequest {
  return {
    projectId: 'project-test',
    conversationId: null,
    messageId: null,
    modality: 'image',
    modelKey: 'contract-test',
    prompt: '把杯子改成蓝色',
    params,
    idempotencyKey: 'contract-idempotency',
  };
}

Deno.test('OpenAI 局部重绘严格分离 image[] 与 mask，并映射输入保真度', async () => {
  const originalFetch = globalThis.fetch;
  const captured: { providerForm?: FormData } = {};
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://assets.test/')) {
      return Promise.resolve(
        new Response(new Uint8Array([137, 80, 78, 71]), {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        }),
      );
    }
    captured.providerForm = init?.body as FormData;
    return Promise.resolve(
      Response.json({ data: [{ b64_json: 'aW1hZ2U=' }] }, { status: 200 }),
    );
  }) as typeof fetch;

  try {
    const ctx = context('gpt-image-1');
    ctx.references = [
      {
        assetId: 'source',
        role: 'content',
        url: 'https://assets.test/source.png',
        mimeType: 'image/png',
      },
      {
        assetId: 'mask',
        role: 'mask',
        url: 'https://assets.test/mask.png',
        mimeType: 'image/png',
      },
    ];
    await openaiAdapter.submit(
      request({
        modality: 'image',
        operation: 'inpaint',
        inputMode: 'original',
        inputFidelity: 'standard',
        maskFeatherPx: 12,
        count: 2,
        aspectRatio: '1:1',
        references: [
          { origin: 'attachment', assetId: 'source', role: 'content' },
          { origin: 'attachment', assetId: 'mask', role: 'mask' },
        ],
      }),
      ctx,
    );

    const providerForm = captured.providerForm;
    assert(providerForm);
    assertEquals(providerForm.getAll('image[]').length, 1);
    assertEquals(providerForm.getAll('mask').length, 1);
    assertEquals(providerForm.get('input_fidelity'), 'low');
    assertEquals(providerForm.get('n'), '2');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test('OpenAI 扩图使用 edits 端点且不伪造蒙版字段', async () => {
  const originalFetch = globalThis.fetch;
  const captured: { providerUrl?: string; providerForm?: FormData } = {};
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === 'https://assets.test/outpaint.png') {
      return Promise.resolve(new Response(new Uint8Array([1]), { status: 200 }));
    }
    captured.providerUrl = url;
    captured.providerForm = init?.body as FormData;
    return Promise.resolve(Response.json({ data: [{ b64_json: 'eA==' }] }));
  }) as typeof fetch;

  try {
    const ctx = context('gpt-image-1');
    ctx.references = [
      {
        assetId: 'source',
        role: 'content',
        url: 'https://assets.test/outpaint.png',
        mimeType: 'image/png',
      },
    ];
    const result = await openaiAdapter.submit(
      request({
        modality: 'image',
        operation: 'outpaint',
        inputMode: 'original',
        count: 1,
        references: [{ origin: 'attachment', assetId: 'source', role: 'content' }],
        outputCanvas: {
          width: 1500,
          height: 1000,
          sourceX: 250,
          sourceY: 0,
          sourceWidth: 1000,
          sourceHeight: 1000,
        },
      }),
      ctx,
    );

    assertEquals(captured.providerUrl, 'https://api.openai.com/v1/images/edits');
    const providerForm = captured.providerForm;
    assert(providerForm);
    assertEquals(providerForm.has('mask'), false);
    assertEquals(providerForm.get('size'), '1536x1024');
    assertEquals(result.kind, 'sync');
    if (result.kind === 'sync') {
      assertEquals(result.candidates[0]?.width, 1536);
      assertEquals(result.candidates[0]?.height, 1024);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test('Ark SeedEdit 在官方 images/generations 请求中传入 image 数组', async () => {
  const originalFetch = globalThis.fetch;
  const captured: { providerBody?: Record<string, unknown> } = {};
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
    captured.providerBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Promise.resolve(
      Response.json({ data: [{ url: 'https://result.test/edit.png', size: '1024x1024' }] }),
    );
  }) as typeof fetch;

  try {
    const ctx = context('doubao-seededit-3-0-i2i-250628');
    ctx.references = [
      {
        assetId: 'source',
        role: 'content',
        url: 'https://assets.test/source.png',
        mimeType: 'image/png',
      },
    ];
    await volcengineAdapter.submit(
      request({
        modality: 'image',
        operation: 'semantic_edit',
        inputMode: 'original',
        count: 1,
        seed: 21,
        aspectRatio: '1:1',
        references: [{ origin: 'attachment', assetId: 'source', role: 'content' }],
      }),
      ctx,
    );

    assertEquals(captured.providerBody?.image, ['https://assets.test/source.png']);
    assertEquals(captured.providerBody?.seed, 21);
    assertEquals(captured.providerBody?.model, 'doubao-seededit-3-0-i2i-250628');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
