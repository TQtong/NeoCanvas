/**
 * 本地与 CI 专用的确定性生成适配器。
 *
 * 适配器遵循真实 Provider 的 submit / poll 契约，但不执行网络请求。提示词中的控制标记用于
 * 可重复覆盖失败、异步完成和永久运行分支；普通输入始终返回同一张有效 PNG。
 *
 * @module functions/_shared/adapters/test
 */

import {
  type AssetCandidate,
  type ImageGenerationParams,
  normalizeImageOperation,
  type PollResult,
  type SubmitResult,
  type UnifiedGenerationRequest,
} from '../types.ts';
import { encodeRgbaPng } from '../image.ts';
import { ApiException } from '../response.ts';
import { requireTestProviderEnabled, TEST_PROVIDER } from '../test-provider.ts';
import { type ModelAdapter, type ModelContext } from './base.ts';

/** 1×1 有效 PNG；固定字节保证测试结果与网络完全无关。 */
const FIXED_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

/** 生成固定图像候选。 */
function fixedCandidate(): AssetCandidate {
  return {
    kind: 'image' as const,
    mimeType: 'image/png',
    fetch: { type: 'base64' as const, data: FIXED_PNG_BASE64 },
    width: 1,
    height: 1,
    sizeBytes: 68,
    isEphemeral: false,
  };
}

/** 将 PNG 字节转换为适配器候选使用的纯 base64，避免大图触发调用栈上限。 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

/**
 * 按精准操作生成尺寸与 Alpha 都可验证的确定性 PNG 候选。
 *
 * 每个候选使用不同填充色，方便 E2E 断言第二候选确实被采用；去背景固定写入透明像素，
 * 放大则严格按源尺寸和倍率输出，确保测试不会绕过生产落库前的媒体门禁。
 */
function precisionCandidates(
  request: UnifiedGenerationRequest,
): Promise<AssetCandidate[]> {
  if (request.params.modality !== 'image') return Promise.resolve([fixedCandidate()]);
  const params = request.params as ImageGenerationParams;
  const operation = normalizeImageOperation(params);
  let width = params.width ?? 1;
  let height = params.height ?? 1;
  if (operation === 'outpaint' && 'outputCanvas' in params) {
    width = params.outputCanvas.width;
    height = params.outputCanvas.height;
  } else if (operation === 'upscale' && 'upscaleFactor' in params) {
    width *= params.upscaleFactor;
    height *= params.upscaleFactor;
  }
  if (width < 1 || height < 1 || width * height > 16_777_216) {
    throw new ApiException('provider_error', '确定性测试 Provider 收到无效输出尺寸');
  }

  const count = operation === 'remove_background' || operation === 'upscale'
    ? 1
    : Math.max(1, Math.min(4, params.count));
  return Promise.all(
    Array.from({ length: count }, async (_, index): Promise<AssetCandidate> => {
      const rgba = new Uint8Array(width * height * 4);
      const red = 48 + index * 50;
      const green = 112 + index * 30;
      const blue = 208 - index * 24;
      for (let offset = 0; offset < rgba.length; offset += 4) {
        rgba[offset] = red;
        rgba[offset + 1] = green;
        rgba[offset + 2] = blue;
        // 去背景至少包含真实透明像素；其余操作保持完全不透明。
        rgba[offset + 3] = operation === 'remove_background' && offset === 0 ? 0 : 255;
      }
      const bytes = await encodeRgbaPng(width, height, rgba);
      return {
        kind: 'image',
        mimeType: 'image/png',
        fetch: { type: 'base64', data: bytesToBase64(bytes) },
        width,
        height,
        sizeBytes: bytes.length,
        isEphemeral: false,
      };
    }),
  );
}

/** 为异步测试任务生成稳定且可解析的外部任务号。 */
async function taskId(prompt: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(prompt)),
  );
  const digest = Array.from(bytes.slice(0, 8), (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
  if (prompt.includes('[[timeout]]')) return `test-timeout-${digest}`;
  if (prompt.includes('[[async-fail]]')) return `test-fail-${digest}`;
  return `test-success-${digest}`;
}

/** 确定性测试适配器。 */
export const testAdapter: ModelAdapter = {
  provider: TEST_PROVIDER,
  supportedOperations: [
    'generate',
    'semantic_edit',
    'inpaint',
    'outpaint',
    'remove_background',
    'upscale',
  ],

  async submit(
    request: UnifiedGenerationRequest,
    _ctx: ModelContext,
  ): Promise<SubmitResult> {
    requireTestProviderEnabled();
    if (request.prompt.includes('[[fatal]]')) {
      throw new ApiException('content_blocked', '确定性测试 Provider 按请求永久拒绝');
    }
    if (request.prompt.includes('[[fail]]')) {
      throw new ApiException('provider_error', '确定性测试 Provider 按请求失败');
    }
    if (
      request.prompt.includes('[[async]]') ||
      request.prompt.includes('[[async-fail]]') ||
      request.prompt.includes('[[timeout]]')
    ) {
      return { kind: 'async', externalJobId: await taskId(request.prompt), progress: 25 };
    }
    return { kind: 'sync', candidates: await precisionCandidates(request) };
  },

  poll(externalJobId: string, _ctx: ModelContext): Promise<PollResult> {
    requireTestProviderEnabled();
    if (externalJobId.startsWith('test-timeout-')) {
      return Promise.resolve({ status: 'running', progress: 50 });
    }
    if (externalJobId.startsWith('test-fail-')) {
      return Promise.resolve({ status: 'failed', error: '确定性异步任务按请求失败' });
    }
    if (externalJobId.startsWith('test-success-')) {
      return Promise.resolve({ status: 'succeeded', candidates: [fixedCandidate()] });
    }
    return Promise.resolve({ status: 'failed', error: '未知的确定性测试任务' });
  },
};
