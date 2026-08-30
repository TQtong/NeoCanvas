import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@1';
import type { ModelCapabilities, UnifiedGenerationRequest } from '../types.ts';
import { inspectRasterImage } from '../image.ts';
import type { ModelContext } from './base.ts';
import { openaiAdapter } from './openai.ts';
import { falAdapter } from './fal.ts';
import {
  extractReplicateOutputUrls,
  REPLICATE_PROFILE_IDS,
  replicateAdapter,
} from './replicate.ts';
import { volcengineAdapter } from './volcengine.ts';
import { jimengAdapter } from './jimeng.ts';
import { googleAdapter } from './google.ts';
import { minimaxAdapter } from './minimax.ts';
import { siliconflowAdapter } from './siliconflow.ts';

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

/** 构造使用本地假端点与有效 AK/SK JSON 的即梦上下文。 */
function jimengContext(providerModel: string): ModelContext {
  const ctx = context(providerModel);
  ctx.credentials = {
    apiKey: JSON.stringify({ accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret-example' }),
    baseUrl: 'https://jimeng.test',
  };
  return ctx;
}

/** 构造 1×1 RGBA PNG；适配器测试只需标准 chunk 结构，CRC 不参与解码。 */
async function rgbaPngBase64(
  red: number,
  green: number,
  blue: number,
  alpha: number,
): Promise<string> {
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const output = new Uint8Array(data.length + 12);
    new DataView(output.buffer).setUint32(0, data.length, false);
    output.set(new TextEncoder().encode(type), 4);
    output.set(data, 8);
    return output;
  };
  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, 1, false);
  headerView.setUint32(4, 1, false);
  header.set([8, 6, 0, 0, 0], 8);
  const compressed = new Uint8Array(
    await new Response(
      new Blob([new Uint8Array([0, red, green, blue, alpha]).buffer])
        .stream()
        .pipeThrough(new CompressionStream('deflate')),
    ).arrayBuffer(),
  );
  const bytes = new Uint8Array(8 + 25 + compressed.length + 12 + 12);
  let offset = 0;
  for (
    const part of [
      new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', header),
      chunk('IDAT', compressed),
      chunk('IEND', new Uint8Array()),
    ]
  ) {
    bytes.set(part, offset);
    offset += part.length;
  }
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
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

Deno.test('即梦图片 4.0 与交互重绘使用专用 Action，轮询句柄冻结查询路由', async () => {
  const originalFetch = globalThis.fetch;
  const captured: Array<
    { action: string | null; version: string | null; body: Record<string, unknown> }
  > = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const action = url.searchParams.get('Action');
    captured.push({
      action,
      version: url.searchParams.get('Version'),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    if (action?.endsWith('GetResult')) {
      return Promise.resolve(
        Response.json({
          code: 10000,
          data: { status: 'done', image_urls: ['https://result.test/jimeng-edit.png'] },
        }),
      );
    }
    return Promise.resolve(
      Response.json({ code: 10000, data: { task_id: `job-${captured.length}` } }),
    );
  }) as typeof fetch;

  try {
    const semantic = jimengContext('jimeng_t2i_v40');
    setToolReferences(semantic);
    const submitted = await jimengAdapter.submit(
      request({
        modality: 'image',
        operation: 'semantic_edit',
        inputMode: 'original',
        inputFidelity: 'high',
        count: 2,
        width: 2048,
        height: 1536,
        references: [{ origin: 'attachment', assetId: 'source', role: 'content' }],
      }),
      semantic,
    );
    assertEquals(submitted.kind, 'async');
    if (submitted.kind !== 'async') throw new Error('即梦语义编辑应返回异步任务');
    assert(submitted.externalJobId.startsWith('jimeng:v1:'));

    // 目录变更不能改变已经提交任务的查询 Action 与 req_key。
    semantic.providerModel = 'entity_seg';
    const polled = await jimengAdapter.poll(submitted.externalJobId, semantic);
    assertEquals(polled.status, 'succeeded');

    const inpaint = jimengContext('jimeng_image2image_dream_inpaint');
    setToolReferences(inpaint, true);
    await jimengAdapter.submit(
      request({
        modality: 'image',
        operation: 'inpaint',
        inputMode: 'original',
        maskFeatherPx: 6,
        count: 1,
        references: [
          { origin: 'attachment', assetId: 'source', role: 'content' },
          { origin: 'attachment', assetId: 'mask', role: 'mask' },
        ],
      }),
      inpaint,
    );

    assertEquals(captured[0]?.action, 'JimengT2IV40SubmitTask');
    assertEquals(captured[0]?.version, '2024-06-06');
    assertEquals(captured[0]?.body.image_urls, ['https://assets.test/source.png']);
    assertEquals(captured[0]?.body.scale, 0.3);
    assertEquals(captured[0]?.body.force_single, false);
    assertEquals(captured[1]?.action, 'JimengT2IV40GetResult');
    assertEquals(captured[1]?.body.req_key, 'jimeng_t2i_v40');
    assertEquals(captured[2]?.action, 'JimengImage2ImageDreamInpaintSubmitTask');
    assertEquals(captured[2]?.body.image_urls, [
      'https://assets.test/source.png',
      'https://assets.test/mask.png',
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test('即梦扩图、去背景和 2× 串联超分使用各自官方同步 Action', async () => {
  const originalFetch = globalThis.fetch;
  const sourcePng = await rgbaPngBase64(240, 120, 60, 255);
  const backgroundMask = await rgbaPngBase64(0, 0, 0, 255);
  const captured: Array<{ action: string | null; body: Record<string, unknown> }> = [];
  let upscalePass = 0;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const action = url.searchParams.get('Action');
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    captured.push({ action, body });
    if (action === 'Img2ImgOutpainting') {
      return Promise.resolve(
        Response.json({ code: 10000, data: { image_urls: ['https://result.test/outpaint.png'] } }),
      );
    }
    if (action === 'EntitySegment') {
      return Promise.resolve(
        Response.json({
          code: 10000,
          data: { binary_data_base64: [sourcePng, backgroundMask] },
        }),
      );
    }
    upscalePass += 1;
    return Promise.resolve(
      Response.json({
        code: 10000,
        data: { image_urls: [`https://result.test/upscale-${upscalePass}.png`] },
      }),
    );
  }) as typeof fetch;

  try {
    const outpaint = jimengContext('i2i_outpainting');
    setToolReferences(outpaint);
    await jimengAdapter.submit(
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
          sourceY: 100,
          sourceWidth: 1000,
          sourceHeight: 800,
        },
      }),
      outpaint,
    );

    const remove = jimengContext('entity_seg');
    setToolReferences(remove);
    const removed = await jimengAdapter.submit(
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

    const upscale = jimengContext('lens_nnsr2_pic_common');
    setToolReferences(upscale);
    await jimengAdapter.submit(
      request({
        modality: 'image',
        operation: 'upscale',
        inputMode: 'original',
        upscaleFactor: 4,
        quality: 'high',
        count: 1,
        references: [{ origin: 'attachment', assetId: 'source', role: 'content' }],
      }),
      upscale,
    );

    assertEquals(captured[0]?.action, 'Img2ImgOutpainting');
    assertEquals(captured[0]?.body.custom_prompt, '把杯子改成蓝色');
    assertEquals(captured[0]?.body.left, 0.25);
    assertEquals(captured[0]?.body.top, 0.125);
    assertEquals(captured[1]?.action, 'EntitySegment');
    assertEquals(captured[1]?.body.return_format, 3);
    assertEquals(captured[1]?.body.refine_mask, 1);
    assertEquals(captured[2]?.action, 'CVProcess');
    assertEquals(captured[2]?.body.image_urls, ['https://assets.test/source.png']);
    assertEquals(captured[3]?.action, 'CVProcess');
    assertEquals(captured[3]?.body.image_urls, ['https://result.test/upscale-1.png']);

    assertEquals(removed.kind, 'sync');
    if (removed.kind === 'sync') {
      const candidate = removed.candidates[0];
      assertEquals(candidate?.fetch.type, 'base64');
      if (candidate?.fetch.type === 'base64') {
        const binary = atob(candidate.fetch.data);
        const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
        assertEquals(await inspectRasterImage(bytes, 'image/png'), {
          width: 1,
          height: 1,
          hasTransparency: true,
        });
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test('即梦目录不能用任意 providerModel 扩大专业操作能力', async () => {
  const ctx = jimengContext('arbitrary-jimeng-action');
  setToolReferences(ctx, true);
  await assertRejects(() =>
    jimengAdapter.submit(
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
});

Deno.test('Google 语义编辑按文本、源图、风格图排序并忽略思考阶段图片', async () => {
  const originalFetch = globalThis.fetch;
  const captured: {
    url?: string;
    headers?: Headers;
    body?: Record<string, unknown>;
  } = {};
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://assets.test/')) {
      return Promise.resolve(
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { 'Content-Type': url.endsWith('.webp') ? 'image/webp' : 'image/png' },
        }),
      );
    }
    captured.url = url;
    captured.headers = new Headers(init?.headers);
    captured.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Promise.resolve(
      Response.json({
        candidates: [{
          content: {
            parts: [
              { inlineData: { mimeType: 'image/png', data: 'dGhvdWdodA==' }, thought: true },
              { text: '完成编辑' },
              { inlineData: { mimeType: 'image/png', data: 'ZmluYWw=' } },
            ],
          },
        }],
      }),
    );
  }) as typeof fetch;

  try {
    const ctx = context('gemini-3-pro-image');
    ctx.capabilities.maxOutputs = 1;
    ctx.references = [
      {
        assetId: 'source',
        role: 'content',
        url: 'https://assets.test/source.png',
        mimeType: 'image/png',
      },
      {
        assetId: 'style',
        role: 'style',
        url: 'https://assets.test/style.webp',
        mimeType: 'image/webp',
      },
    ];
    const result = await googleAdapter.submit(
      request({
        modality: 'image',
        operation: 'semantic_edit',
        inputMode: 'original',
        count: 1,
        aspectRatio: '16:9',
        sizePreset: '2k',
        references: [
          { origin: 'attachment', assetId: 'source', role: 'content' },
          { origin: 'attachment', assetId: 'style', role: 'style' },
        ],
      }),
      ctx,
    );

    assertEquals(
      captured.url,
      'https://generativelanguage.googleapis.com/v1/models/gemini-3-pro-image:generateContent',
    );
    assertEquals(captured.headers?.get('x-goog-api-key'), 'test-key');
    assertEquals(new URL(captured.url!).search, '');
    const contents = captured.body?.contents as Array<{ parts: Array<Record<string, unknown>> }>;
    assertEquals(contents[0]?.parts[0], { text: '把杯子改成蓝色' });
    assertEquals(
      contents[0]?.parts.slice(1).map((part) => (part.inlineData as { mimeType: string }).mimeType),
      ['image/png', 'image/webp'],
    );
    assertEquals(captured.body?.generationConfig, {
      responseModalities: ['IMAGE'],
      responseFormat: { image: { aspectRatio: '16:9', imageSize: '2K' } },
    });
    assertEquals(result.kind, 'sync');
    if (result.kind === 'sync') {
      assertEquals(result.candidates.length, 1);
      assertEquals(result.candidates[0]?.fetch, { type: 'base64', data: 'ZmluYWw=' });
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test('Google 对无最终图片和像素级蒙版操作显式失败', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    if (String(input).startsWith('https://assets.test/')) {
      return Promise.resolve(
        new Response(new Uint8Array([1]), { headers: { 'Content-Type': 'image/png' } }),
      );
    }
    return Promise.resolve(
      Response.json({ candidates: [{ content: { parts: [{ text: '拒绝' }] } }] }),
    );
  }) as typeof fetch;

  try {
    const semantic = context('gemini-3-pro-image');
    setToolReferences(semantic);
    await assertRejects(() =>
      googleAdapter.submit(
        request({
          modality: 'image',
          operation: 'semantic_edit',
          inputMode: 'original',
          count: 1,
          references: [{ origin: 'attachment', assetId: 'source', role: 'content' }],
        }),
        semantic,
      )
    );

    const inpaint = context('gemini-3-pro-image');
    setToolReferences(inpaint, true);
    await assertRejects(() =>
      googleAdapter.submit(
        request({
          modality: 'image',
          operation: 'inpaint',
          inputMode: 'original',
          maskFeatherPx: 4,
          count: 1,
          references: [
            { origin: 'attachment', assetId: 'source', role: 'content' },
            { origin: 'attachment', assetId: 'mask', role: 'mask' },
          ],
        }),
        inpaint,
      )
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test('MiniMax 只把单个人物内容源图映射为 character 主体参考', async () => {
  const originalFetch = globalThis.fetch;
  const captured: { body?: Record<string, unknown> } = {};
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
    captured.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Promise.resolve(
      Response.json({
        data: { image_urls: ['https://result.test/minimax.jpeg'] },
        base_resp: { status_code: 0 },
      }),
    );
  }) as typeof fetch;

  try {
    const ctx = context('image-01');
    setToolReferences(ctx);
    await minimaxAdapter.submit(
      request({
        modality: 'image',
        operation: 'semantic_edit',
        inputMode: 'original',
        count: 2,
        seed: 88,
        aspectRatio: '3:2',
        references: [{ origin: 'attachment', assetId: 'source', role: 'content' }],
      }),
      ctx,
    );

    assertEquals(captured.body?.subject_reference, [{
      type: 'character',
      image_file: 'https://assets.test/source.png',
    }]);
    assertEquals(captured.body?.seed, 88);
    assertEquals(captured.body?.n, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test('MiniMax 拒绝蒙版、扩图、放大与非受控图片模型', async () => {
  const ctx = context('image-01');
  setToolReferences(ctx, true);
  for (
    const params of [
      {
        modality: 'image' as const,
        operation: 'inpaint' as const,
        inputMode: 'original' as const,
        maskFeatherPx: 0,
        count: 1,
        references: [
          { origin: 'attachment' as const, assetId: 'source', role: 'content' as const },
          { origin: 'attachment' as const, assetId: 'mask', role: 'mask' as const },
        ],
      },
      {
        modality: 'image' as const,
        operation: 'outpaint' as const,
        inputMode: 'original' as const,
        count: 1,
        outputCanvas: {
          width: 1200,
          height: 1000,
          sourceX: 100,
          sourceY: 0,
          sourceWidth: 1000,
          sourceHeight: 1000,
        },
        references: [{
          origin: 'attachment' as const,
          assetId: 'source',
          role: 'content' as const,
        }],
      },
      {
        modality: 'image' as const,
        operation: 'upscale' as const,
        inputMode: 'original' as const,
        upscaleFactor: 2 as const,
        count: 1 as const,
        references: [{
          origin: 'attachment' as const,
          assetId: 'source',
          role: 'content' as const,
        }],
      },
    ]
  ) {
    await assertRejects(() => minimaxAdapter.submit(request(params), ctx));
  }

  const arbitraryModel = context('arbitrary-minimax-model');
  setToolReferences(arbitraryModel);
  await assertRejects(() =>
    minimaxAdapter.submit(
      request({
        modality: 'image',
        operation: 'semantic_edit',
        inputMode: 'original',
        count: 1,
        references: [{ origin: 'attachment', assetId: 'source', role: 'content' }],
      }),
      arbitraryModel,
    )
  );
});

Deno.test('SiliconFlow Qwen Edit 2509 映射三张有序输入且不发送生成专属字段', async () => {
  const originalFetch = globalThis.fetch;
  const captured: { body?: Record<string, unknown> } = {};
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://assets.test/')) {
      const marker = url.includes('source') ? 1 : url.includes('style-1') ? 2 : 3;
      return Promise.resolve(
        new Response(new Uint8Array([marker]), { headers: { 'Content-Type': 'image/png' } }),
      );
    }
    captured.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Promise.resolve(Response.json({ images: [{ url: 'https://result.test/qwen.png' }] }));
  }) as typeof fetch;

  try {
    const ctx = context('Qwen/Qwen-Image-Edit-2509');
    ctx.references = [
      {
        assetId: 'source',
        role: 'content',
        url: 'https://assets.test/source.png',
        mimeType: 'image/png',
      },
      {
        assetId: 'style-1',
        role: 'style',
        url: 'https://assets.test/style-1.png',
        mimeType: 'image/png',
      },
      {
        assetId: 'style-2',
        role: 'style',
        url: 'https://assets.test/style-2.png',
        mimeType: 'image/png',
      },
    ];
    await siliconflowAdapter.submit(
      request({
        modality: 'image',
        operation: 'semantic_edit',
        inputMode: 'original',
        count: 1,
        references: [
          { origin: 'attachment', assetId: 'source', role: 'content' },
          { origin: 'attachment', assetId: 'style-1', role: 'style' },
          { origin: 'attachment', assetId: 'style-2', role: 'style' },
        ],
      }),
      ctx,
    );

    assertEquals(captured.body?.image, 'data:image/png;base64,AQ==');
    assertEquals(captured.body?.image2, 'data:image/png;base64,Ag==');
    assertEquals(captured.body?.image3, 'data:image/png;base64,Aw==');
    assertEquals('image_size' in captured.body!, false);
    assertEquals('batch_size' in captured.body!, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test('SiliconFlow 普通模型与编辑模型入口严格隔离', async () => {
  const originalFetch = globalThis.fetch;
  const captured: { body?: Record<string, unknown> } = {};
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
    captured.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Promise.resolve(Response.json({ images: [{ url: 'https://result.test/kolors.png' }] }));
  }) as typeof fetch;

  try {
    const kolors = context('Kwai-Kolors/Kolors');
    await siliconflowAdapter.submit(
      request({
        modality: 'image',
        operation: 'generate',
        count: 3,
        aspectRatio: '3:2',
        references: [],
      }),
      kolors,
    );
    assertEquals(captured.body?.image_size, '1024x768');
    assertEquals(captured.body?.batch_size, 3);

    const ordinary = context('Qwen/Qwen-Image');
    setToolReferences(ordinary);
    await assertRejects(() =>
      siliconflowAdapter.submit(
        request({
          modality: 'image',
          operation: 'semantic_edit',
          inputMode: 'original',
          count: 1,
          references: [{ origin: 'attachment', assetId: 'source', role: 'content' }],
        }),
        ordinary,
      )
    );

    const edit = context('Qwen/Qwen-Image-Edit');
    await assertRejects(() =>
      siliconflowAdapter.submit(
        request({ modality: 'image', operation: 'generate', count: 1, references: [] }),
        edit,
      )
    );

    setToolReferences(edit, true);
    await assertRejects(() =>
      siliconflowAdapter.submit(
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
        edit,
      )
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
