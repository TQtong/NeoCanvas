/**
 * 火山方舟 Volcengine Ark 适配器 —— Seedance 2.0（视频，异步）与 Seedream（图像，同步）。
 *
 * Seedance 为典型异步模型：提交得到外部任务号，需轮询直至产出视频；产出 URL 为临时
 * 链接，由完成阶段取回转存（第 05 篇第三、五节）。Seedream 为同步图像生成。
 *
 * @module functions/_shared/adapters/volcengine
 */

import {
  type ImageGenerationParams,
  type PollResult,
  type Provider,
  type SubmitResult,
  type UnifiedGenerationRequest,
  type VideoGenerationParams,
} from '../types.ts';
import { ApiException } from '../response.ts';
import { requireProviderKey, resolveSize, type ModelAdapter, type ModelContext } from './base.ts';

const ARK_BASE = 'https://ark.cn-beijing.volces.com/api/v3';

/** 视频任务内容项。 */
interface ArkContentItem {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string };
}

/** 提交视频生成任务（异步）。 */
async function submitVideo(
  request: UnifiedGenerationRequest,
  ctx: ModelContext,
  apiKey: string,
): Promise<SubmitResult> {
  const params = request.params as VideoGenerationParams;
  // Ark Seedance 以文本命令参数承载比例 / 时长 / 分辨率
  const ratio = params.aspectRatio ?? '16:9';
  const commandText =
    `${request.prompt} --ratio ${ratio} --dur ${params.durationSec} --rs ${params.resolution}` +
    (params.seed != null ? ` --seed ${params.seed}` : '');

  const content: ArkContentItem[] = [{ type: 'text', text: commandText }];
  // 关键帧序列（逐段首尾帧）：仅声明 supportsKeyframeSequence 的模型经 validateParams 放行至此，
  // 按链方向有序下发全部关键帧（相邻两帧构成一段：前者首帧、后者尾帧）。首/尾帧的精确 Ark 载荷标注
  // 与分段拼接随 Seedance 实际激活时按其在线契约定稿；否则退回单首帧 / 参考图图生视频。
  if (ctx.keyframes.length > 0) {
    for (const kf of ctx.keyframes) {
      content.push({ type: 'image_url', image_url: { url: kf.url } });
    }
  } else {
    const firstFrame = ctx.references.find((r) => r.role === 'first_frame') ?? ctx.references[0];
    if (firstFrame) {
      content.push({ type: 'image_url', image_url: { url: firstFrame.url } });
    }
  }

  const response = await fetch(`${ARK_BASE}/contents/generations/tasks`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: ctx.providerModel, content }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new ApiException('provider_error', `Ark 视频任务提交失败（${response.status}）`, {
      upstream: text.slice(0, 500),
    });
  }

  const json = (await response.json()) as { id?: string };
  if (!json.id) {
    throw new ApiException('provider_error', 'Ark 未返回任务号');
  }
  return { kind: 'async', externalJobId: json.id, progress: 5 };
}

/** 提交图像生成（同步）。 */
async function submitImage(
  request: UnifiedGenerationRequest,
  ctx: ModelContext,
  apiKey: string,
): Promise<SubmitResult> {
  const params = request.params as ImageGenerationParams;
  const { width, height } = resolveSize(params);

  const response = await fetch(`${ARK_BASE}/images/generations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: ctx.providerModel,
      prompt: request.prompt,
      size: `${width}x${height}`,
      response_format: 'url',
      n: Math.min(params.count || 1, ctx.capabilities.maxOutputs),
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new ApiException('provider_error', `Ark 图像生成失败（${response.status}）`, {
      upstream: text.slice(0, 500),
    });
  }

  const json = (await response.json()) as {
    data?: Array<{ url?: string; b64_json?: string }>;
  };
  const candidates = (json.data ?? []).map((item) =>
    item.b64_json
      ? {
          kind: 'image' as const,
          mimeType: 'image/png',
          fetch: { type: 'base64' as const, data: item.b64_json },
          width,
          height,
          isEphemeral: false,
        }
      : {
          kind: 'image' as const,
          mimeType: 'image/png',
          fetch: { type: 'url' as const, url: item.url ?? '' },
          width,
          height,
          isEphemeral: true,
        },
  );
  if (candidates.length === 0) {
    throw new ApiException('provider_error', 'Ark 未返回图像');
  }
  return { kind: 'sync', candidates };
}

export const volcengineAdapter: ModelAdapter = {
  provider: 'volcengine' as Provider,

  submit(request: UnifiedGenerationRequest, ctx: ModelContext): Promise<SubmitResult> {
    const apiKey = requireProviderKey('ARK_API_KEY', 'volcengine');
    if (request.modality === 'video') return submitVideo(request, ctx, apiKey);
    if (request.modality === 'image') return submitImage(request, ctx, apiKey);
    return Promise.reject(new ApiException('unsupported_param', 'Ark 适配器仅支持图像 / 视频'));
  },

  async poll(externalJobId: string): Promise<PollResult> {
    const apiKey = requireProviderKey('ARK_API_KEY', 'volcengine');
    const response = await fetch(`${ARK_BASE}/contents/generations/tasks/${externalJobId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) {
      const text = await response.text();
      throw new ApiException('provider_error', `Ark 任务查询失败（${response.status}）`, {
        upstream: text.slice(0, 300),
      });
    }
    const json = (await response.json()) as {
      status?: string;
      content?: { video_url?: string };
      error?: { message?: string };
    };

    switch (json.status) {
      case 'succeeded': {
        const url = json.content?.video_url;
        if (!url) return { status: 'failed', error: 'Ark 成功但未返回视频地址' };
        return {
          status: 'succeeded',
          candidates: [
            {
              kind: 'video',
              mimeType: 'video/mp4',
              fetch: { type: 'url', url },
              isEphemeral: true,
            },
          ],
        };
      }
      case 'failed':
        return { status: 'failed', error: json.error?.message ?? 'Ark 任务失败' };
      case 'running':
        return { status: 'running', progress: 60 };
      case 'queued':
      default:
        return { status: 'running', progress: 20 };
    }
  },
};
