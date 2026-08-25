/**
 * 本地与 CI 专用的确定性生成适配器。
 *
 * 适配器遵循真实 Provider 的 submit / poll 契约，但不执行网络请求。提示词中的控制标记用于
 * 可重复覆盖失败、异步完成和永久运行分支；普通输入始终返回同一张有效 PNG。
 *
 * @module functions/_shared/adapters/test
 */

import { type PollResult, type SubmitResult, type UnifiedGenerationRequest } from '../types.ts';
import { ApiException } from '../response.ts';
import { requireTestProviderEnabled, TEST_PROVIDER } from '../test-provider.ts';
import { type ModelAdapter, type ModelContext } from './base.ts';

/** 1×1 有效 PNG；固定字节保证测试结果与网络完全无关。 */
const FIXED_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

/** 生成固定图像候选。 */
function fixedCandidate() {
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
    return { kind: 'sync', candidates: [fixedCandidate()] };
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
