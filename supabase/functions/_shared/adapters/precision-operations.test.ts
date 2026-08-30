import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@1';
import type { ModelCapabilities, UnifiedGenerationRequest } from '../types.ts';
import type { ModelContext } from './base.ts';
import { openaiAdapter } from './openai.ts';
import { falAdapter } from './fal.ts';
import {
  extractReplicateOutputUrls,
  REPLICATE_PROFILE_IDS,
  replicateAdapter,
} from './replicate.ts';
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

/** 为工具型适配器设置标准源图与可选蒙版。 */
function setToolReferences(ctx: ModelContext, withMask = false): void {
  ctx.references = [
    {
      assetId: 'source',
      role: 'content',
      url: 'https://assets.test/source.png',
      mimeType: 'image/png',
    },
    ...(withMask
      ? [
        {
          assetId: 'mask',
          role: 'mask' as const,
          url: 'https://assets.test/mask.png',
          mimeType: 'image/png',
        },
      ]
      : []),
  ];
}

Deno.test('fal 三个工具 Profile 使用独立 endpoint 与固定输入字段', async () => {
  const originalFetch = globalThis.fetch;
  const captured: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    captured.push({
      url: String(input),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return Promise.resolve(Response.json({ request_id: `fal-request-${captured.length}` }));
  }) as typeof fetch;

  try {
    const inpaint = context('fal-ai/inpaint');
    setToolReferences(inpaint, true);
    await falAdapter.submit(
      request({
        modality: 'image',
        operation: 'inpaint',
        inputMode: 'original',
        maskFeatherPx: 8,
        count: 1,
        references: [
          { origin: 'attachment', assetId: 'source', role: 'content' },
          { origin: 'attachment', assetId: 'mask', role: 'mask' },
        ],
      }),
      inpaint,
    );

    const remove = context('fal-ai/birefnet');
    setToolReferences(remove);
    await falAdapter.submit(
      request({
        modality: 'image',
        operation: 'remove_background',
        inputMode: 'original',
        background: 'transparent',
        count: 1,
        references: [{ origin: 'attachment', assetId: 'source', role: 'content' }],
      }),
      remove,
    );

    const upscale = context('fal-ai/topaz/upscale/image');
    setToolReferences(upscale);
    await falAdapter.submit(
      request({
        modality: 'image',
        operation: 'upscale',
        inputMode: 'original',
        upscaleFactor: 4,
        count: 1,
        references: [{ origin: 'attachment', assetId: 'source', role: 'content' }],
      }),
      upscale,
    );

    assertEquals(captured[0]?.url, 'https://queue.fal.run/fal-ai/inpaint');
    assertEquals(captured[0]?.body.image_url, 'https://assets.test/source.png');
    assertEquals(captured[0]?.body.mask_url, 'https://assets.test/mask.png');
    assertEquals(
      captured[0]?.body.model_name,
      'diffusers/stable-diffusion-xl-1.0-inpainting-0.1',
    );
    assertEquals(captured[1]?.url, 'https://queue.fal.run/fal-ai/birefnet');
    assertEquals(captured[1]?.body.output_format, 'png');
    assertEquals(captured[1]?.body.refine_foreground, true);
    assertEquals(captured[2]?.url, 'https://queue.fal.run/fal-ai/topaz/upscale/image');
    assertEquals(captured[2]?.body.upscale_factor, 4);
    assertEquals(captured[2]?.body.face_enhancement, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test('fal 轮询句柄冻结提交 endpoint 并解析单图结果', async () => {
  const originalFetch = globalThis.fetch;
  let externalJobId = '';
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/status')) return Promise.resolve(Response.json({ status: 'COMPLETED' }));
    if (url.includes('/requests/')) {
      return Promise.resolve(
        Response.json({
          image: {
            url: 'https://result.test/inpaint.png',
            content_type: 'image/png',
            width: 768,
            height: 512,
          },
        }),
      );
    }
    return Promise.resolve(Response.json({ request_id: 'frozen-endpoint-job' }));
  }) as typeof fetch;

  try {
    const ctx = context('fal-ai/inpaint');
    setToolReferences(ctx, true);
    const submitted = await falAdapter.submit(
      request({
        modality: 'image',
        operation: 'inpaint',
        inputMode: 'original',
        maskFeatherPx: 0,
        count: 1,
        references: [
          { origin: 'attachment', assetId: 'source', role: 'content' },
          { origin: 'attachment', assetId: 'mask', role: 'mask' },
        ],
      }),
      ctx,
    );
    assertEquals(submitted.kind, 'async');
    if (submitted.kind === 'async') externalJobId = submitted.externalJobId;
    assert(externalJobId.startsWith('fal:v1:'));

    // 即使模型目录后来变为另一工具，句柄仍必须查询最初的 inpaint endpoint。
    ctx.providerModel = 'fal-ai/birefnet';
    const polled = await falAdapter.poll(externalJobId, ctx);
    assertEquals(polled.status, 'succeeded');
    if (polled.status === 'succeeded') {
      assertEquals(polled.candidates[0]?.fetch, {
        type: 'url',
        url: 'https://result.test/inpaint.png',
      });
      assertEquals(polled.candidates[0]?.width, 768);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test('Replicate 受控 Profile 固定版本并映射重绘、去背景和放大输入', async () => {
  const originalFetch = globalThis.fetch;
  const bodies: Array<{ version: string; input: Record<string, unknown> }> = [];
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as (typeof bodies)[number]);
    return Promise.resolve(Response.json({ id: `prediction-${bodies.length}` }));
  }) as typeof fetch;

  try {
    const inpaint = context(REPLICATE_PROFILE_IDS.inpaint);
    setToolReferences(inpaint, true);
    await replicateAdapter.submit(
      request({
        modality: 'image',
        operation: 'inpaint',
        inputMode: 'original',
        maskFeatherPx: 16,
        width: 1001,
        height: 701,
        count: 3,
        references: [
          { origin: 'attachment', assetId: 'source', role: 'content' },
          { origin: 'attachment', assetId: 'mask', role: 'mask' },
        ],
      }),
      inpaint,
    );

    const remove = context(REPLICATE_PROFILE_IDS.removeBackground);
    setToolReferences(remove);
    await replicateAdapter.submit(
      request({
        modality: 'image',
        operation: 'remove_background',
        inputMode: 'original',
        background: 'transparent',
        count: 1,
        references: [{ origin: 'attachment', assetId: 'source', role: 'content' }],
      }),
      remove,
    );

    const upscale = context(REPLICATE_PROFILE_IDS.upscale);
    setToolReferences(upscale);
    await replicateAdapter.submit(
      request({
        modality: 'image',
        operation: 'upscale',
        inputMode: 'original',
        upscaleFactor: 2,
        count: 1,
        references: [{ origin: 'attachment', assetId: 'source', role: 'content' }],
      }),
      upscale,
    );

    assertEquals(
      bodies[0]?.version,
      '95b7223104132402a9ae91cc677285bc5eb997834bd2349fa486f53910fd68b3',
    );
    assertEquals(bodies[0]?.input.mask, 'https://assets.test/mask.png');
    assertEquals(bodies[0]?.input.width, 1024);
    assertEquals(bodies[0]?.input.height, 704);
    assertEquals(bodies[0]?.input.num_outputs, 3);
    assertEquals(
      bodies[1]?.version,
      'a029dff38972b5fda4ec5d75d7d1cd25aeff621d2cf4946a41055d7db66b80bc',
    );
    assertEquals(bodies[1]?.input.background_type, 'rgba');
    assertEquals(
      bodies[2]?.version,
      'b3ef194191d13140337468c916c2c5b96dd0cb06dffc032a022a31807f6a5ea8',
    );
    assertEquals(bodies[2]?.input.scale, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test('Replicate 拒绝目录伪造 Profile 并归一化受控输出结构', async () => {
  const ctx = context('arbitrary-version-hash');
  setToolReferences(ctx, true);
  await assertRejects(() =>
    replicateAdapter.submit(
      request({
        modality: 'image',
        operation: 'inpaint',
        inputMode: 'original',
        maskFeatherPx: 0,
        count: 1,
        references: [
          { origin: 'attachment', assetId: 'source', role: 'content' },
          { origin: 'attachment', assetId: 'mask', role: 'mask' },
        ],
      }),
      ctx,
    )
  );

  assertEquals(
    extractReplicateOutputUrls({
      output: [
        'https://result.test/one.png',
        { image: { url: 'https://result.test/two.png' } },
        'not-a-url',
      ],
    }),
    ['https://result.test/one.png', 'https://result.test/two.png'],
  );
});
