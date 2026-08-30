import { assertEquals, assertRejects, assertThrows } from 'jsr:@std/assert@1';
import { testAdapter } from './adapters/test.ts';
import type { ModelContext } from './adapters/base.ts';
import { ApiException } from './response.ts';
import { isTestProviderEnabled } from './test-provider.ts';
import type { UnifiedGenerationRequest } from './types.ts';

/** 构造最小可执行的确定性图像请求。 */
function request(prompt: string): UnifiedGenerationRequest {
  return {
    projectId: 'project-1',
    conversationId: null,
    messageId: null,
    modality: 'image',
    modelKey: 'neocanvas-e2e-image',
    prompt,
    idempotencyKey: prompt,
    params: { modality: 'image', count: 1, references: [] },
  };
}

/** 适配器不读取这些字段，但仍使用完整上下文验证统一接口没有测试捷径。 */
const context = {
  modelKey: 'neocanvas-e2e-image',
  capabilities: {
    imageOperations: ['generate'],
    aspectRatios: ['1:1'],
    sizes: [],
    maxOutputs: 1,
    supportsNegativePrompt: false,
    supportsReferenceImages: false,
    supportsImageToVideo: false,
    supportsSeed: false,
    qualities: [],
    isAsync: false,
    supportsWebhook: false,
  },
  providerModel: 'deterministic-v1',
  references: [],
  keyframes: [],
  credentials: { apiKey: 'test-only' },
} satisfies ModelContext;

Deno.test('测试 Provider 必须显式启用且生产环境永远拒绝', () => {
  assertEquals(
    isTestProviderEnabled({ testMode: undefined, appEnv: 'test', deploymentId: undefined }),
    false,
  );
  assertEquals(
    isTestProviderEnabled({ testMode: 'true', appEnv: 'test', deploymentId: undefined }),
    true,
  );
  assertThrows(
    () =>
      isTestProviderEnabled({
        testMode: 'true',
        appEnv: 'production',
        deploymentId: undefined,
      }),
    ApiException,
  );
  assertEquals(
    isTestProviderEnabled({ testMode: 'true', appEnv: 'test', deploymentId: 'local-runtime' }),
    true,
  );
});

Deno.test('确定性适配器覆盖同步、异步、失败与超时分支', async () => {
  const previousMode = Deno.env.get('NEOCANVAS_TEST_MODE');
  const previousAppEnv = Deno.env.get('APP_ENV');
  const previousDeployment = Deno.env.get('DENO_DEPLOYMENT_ID');
  Deno.env.set('NEOCANVAS_TEST_MODE', 'true');
  Deno.env.set('APP_ENV', 'test');
  Deno.env.delete('DENO_DEPLOYMENT_ID');
  try {
    const sync = await testAdapter.submit(request('固定海报'), context);
    assertEquals(sync.kind, 'sync');
    if (sync.kind === 'sync') assertEquals(sync.candidates[0].mimeType, 'image/png');

    const asyncResult = await testAdapter.submit(request('固定海报 [[async]]'), context);
    if (asyncResult.kind !== 'async') throw new Error('预期异步任务');
    const completed = await testAdapter.poll(asyncResult.externalJobId, context);
    assertEquals(completed.status, 'succeeded');

    const timeout = await testAdapter.submit(request('固定海报 [[timeout]]'), context);
    if (timeout.kind !== 'async') throw new Error('预期超时任务');
    assertEquals((await testAdapter.poll(timeout.externalJobId, context)).status, 'running');

    await assertRejects(
      () => testAdapter.submit(request('固定海报 [[fail]]'), context),
      ApiException,
    );
    const fatal = await assertRejects(
      () => testAdapter.submit(request('固定海报 [[fatal]]'), context),
      ApiException,
    );
    assertEquals(fatal.code, 'content_blocked');
  } finally {
    if (previousMode === undefined) Deno.env.delete('NEOCANVAS_TEST_MODE');
    else Deno.env.set('NEOCANVAS_TEST_MODE', previousMode);
    if (previousAppEnv === undefined) Deno.env.delete('APP_ENV');
    else Deno.env.set('APP_ENV', previousAppEnv);
    if (previousDeployment === undefined) Deno.env.delete('DENO_DEPLOYMENT_ID');
    else Deno.env.set('DENO_DEPLOYMENT_ID', previousDeployment);
  }
});
