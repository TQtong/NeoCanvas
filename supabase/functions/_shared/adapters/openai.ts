/**
 * OpenAI 图像适配器 —— GPT Image 2（第 05 篇第三节）。
 *
 * 对接 OpenAI 图像生成接口。文生图走 `/v1/images/generations`，带参考图的编辑走
 * `/v1/images/edits`（multipart）。多为同步返回，产出以 base64 归一化为资产候选。
 *
 * @module functions/_shared/adapters/openai
 */

import {
  type ImageGenerationParams,
  normalizeImageOperation,
  type PollResult,
  type Provider,
  type SubmitResult,
  type UnifiedGenerationRequest,
} from '../types.ts';
import { ApiException } from '../response.ts';
import { type ModelAdapter, type ModelContext, resolveSize } from './base.ts';

const API_BASE = 'https://api.openai.com/v1';

/** OpenAI GPT Image 支持的输出尺寸及其真实像素。 */
interface OpenAIImageSize {
  value: '1024x1024' | '1536x1024' | '1024x1536';
  width: number;
  height: number;
}

/** 把宽高映射到 OpenAI 支持的 size 取值，并返回真实输出像素。 */
function toOpenAISize(width: number, height: number): OpenAIImageSize {
  if (width === height) return { value: '1024x1024', width: 1024, height: 1024 };
  return width > height
    ? { value: '1536x1024', width: 1536, height: 1024 }
    : { value: '1024x1536', width: 1024, height: 1536 };
}

/** 下载一份编辑输入，并以 Provider 可识别的文件名附加到 multipart。 */
async function appendRemoteFile(form: FormData, field: string, url: string, mimeType: string) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new ApiException('provider_error', `OpenAI 编辑输入下载失败（${response.status}）`);
  }
  const extension = mimeType.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png';
  form.append(field, await response.blob(), `${field.replaceAll('[]', '')}.${extension}`);
}

export const openaiAdapter: ModelAdapter = {
  provider: 'openai' as Provider,
  supportedOperations: ['generate', 'semantic_edit', 'inpaint', 'outpaint'],

  async submit(request: UnifiedGenerationRequest, ctx: ModelContext): Promise<SubmitResult> {
    if (request.modality !== 'image') {
      throw new ApiException('unsupported_param', 'OpenAI 适配器仅支持图像模态');
    }
    const apiKey = ctx.credentials.apiKey;
    const baseUrl = (ctx.credentials.baseUrl ?? API_BASE).replace(/\/$/, '');
    const params = request.params as ImageGenerationParams;
    const operation = normalizeImageOperation(params);
    const desiredSize = operation === 'outpaint' && 'outputCanvas' in params
      ? params.outputCanvas
      : resolveSize(params);
    const size = toOpenAISize(desiredSize.width, desiredSize.height);
    const count = Math.min(params.count || 1, ctx.capabilities.maxOutputs);

    let response: Response;
    if (operation !== 'generate') {
      // 编辑接口严格区分内容图 `image[]` 与局部重绘蒙版 `mask`，二者不可混传。
      const form = new FormData();
      form.append('model', ctx.providerModel);
      form.append('prompt', request.prompt);
      form.append('n', String(count));
      form.append('size', size.value);
      if (params.quality && params.quality !== 'auto') form.append('quality', params.quality);
      if ('inputFidelity' in params && params.inputFidelity) {
        form.append('input_fidelity', params.inputFidelity === 'high' ? 'high' : 'low');
      }
      if ('background' in params && params.background) {
        form.append('background', params.background);
        if (params.background === 'transparent') form.append('output_format', 'png');
      }

      const images = ctx.references.filter((reference) => reference.role !== 'mask');
      if (images.length === 0) {
        throw new ApiException('invalid_params', 'OpenAI 图片编辑缺少源图');
      }
      for (const ref of images) {
        await appendRemoteFile(form, 'image[]', ref.url, ref.mimeType);
      }

      const mask = ctx.references.find((reference) => reference.role === 'mask');
      if (operation === 'inpaint') {
        if (!mask) throw new ApiException('invalid_params', 'OpenAI 局部重绘缺少蒙版');
        await appendRemoteFile(form, 'mask', mask.url, mask.mimeType);
      }
      response = await fetch(`${baseUrl}/images/edits`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      });
    } else {
      const body: Record<string, unknown> = {
        model: ctx.providerModel,
        prompt: request.prompt,
        n: count,
        size: size.value,
      };
      if (params.quality && params.quality !== 'auto') body.quality = params.quality;
      response = await fetch(`${baseUrl}/images/generations`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    }

    if (!response.ok) {
      const text = await response.text();
      throw new ApiException('provider_error', `OpenAI 生成失败（${response.status}）`, {
        upstream: text.slice(0, 500),
      });
    }

    const json = (await response.json()) as {
      data: Array<{ b64_json?: string; url?: string }>;
    };

    const candidates = (json.data ?? []).map((item) => {
      if (item.b64_json) {
        return {
          kind: 'image' as const,
          mimeType: 'image/png',
          fetch: { type: 'base64' as const, data: item.b64_json },
          width: size.width,
          height: size.height,
          isEphemeral: false,
        };
      }
      return {
        kind: 'image' as const,
        mimeType: 'image/png',
        fetch: { type: 'url' as const, url: item.url ?? '' },
        width: size.width,
        height: size.height,
        isEphemeral: true,
      };
    });

    if (candidates.length === 0) {
      throw new ApiException('provider_error', 'OpenAI 未返回任何图像');
    }
    return { kind: 'sync', candidates };
  },

  poll(): Promise<PollResult> {
    // GPT Image 为同步模型，无异步查询语义
    return Promise.reject(new ApiException('internal_error', 'OpenAI 图像为同步模型，不应轮询'));
  },
};
