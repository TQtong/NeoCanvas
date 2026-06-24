/**
 * 文本 / LLM 适配器（第 05 篇第七节：编排型语言模型经适配器访问）。
 *
 * 把编排所用的语言模型封装为统一接口（流式回复 + 一次性 JSON 规划），编排层只依赖此
 * 接口而不内联具体提供商 HTTP 细节。默认实现对接 OpenAI 兼容的 chat/completions 协议，
 * 可经 ORCHESTRATOR_LLM_BASE_URL 指向兼容端点（如火山方舟）。
 *
 * @module functions/_shared/adapters/text
 */

import { ApiException } from '../response.ts';

/** LLM 对话消息。 */
export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** LLM 调用选项。 */
export interface LlmOptions {
  temperature?: number;
  maxTokens?: number;
  /** 要求模型输出 JSON 对象（用于结构化规划）。 */
  json?: boolean;
}

/** 文本 / LLM 适配器统一接口。 */
export interface LlmAdapter {
  readonly provider: string;
  /** 流式生成文本。 */
  stream(messages: LlmMessage[], opts?: LlmOptions): AsyncGenerator<string>;
  /** 一次性生成文本（可要求 JSON 输出）。 */
  complete(messages: LlmMessage[], opts?: LlmOptions): Promise<string>;
}

/** 读取编排 LLM 配置。 */
function llmConfig(): { apiKey: string | undefined; model: string; baseUrl: string } {
  const apiKey = Deno.env.get('ORCHESTRATOR_LLM_API_KEY') ?? Deno.env.get('OPENAI_API_KEY');
  const model = Deno.env.get('ORCHESTRATOR_LLM_MODEL') ?? 'gpt-4o-mini';
  const baseUrl = (Deno.env.get('ORCHESTRATOR_LLM_BASE_URL') ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  return { apiKey, model, baseUrl };
}

/** 是否已配置编排 LLM（无则上层走确定性回退）。 */
export function isLlmConfigured(): boolean {
  return Boolean(Deno.env.get('ORCHESTRATOR_LLM_API_KEY') ?? Deno.env.get('OPENAI_API_KEY'));
}

/** 编排 LLM 单次调用超时（ms）：避免外呼缓慢/挂起阻塞整个编排，超时由上层退化到确定性兜底。
 * 取 30s：容器→SiliconFlow 的链路比本机直连慢，DeepSeek 出完整海报版式 JSON 需更宽裕的窗口。 */
const LLM_TIMEOUT_MS = 30000;

/** 带超时的 fetch：超时即 abort，调用方据此抛错并触发兜底，绝不无限挂起。 */
async function llmFetch(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 解析 OpenAI 风格 SSE 行，逐块产出增量文本。 */
async function* parseSseDeltas(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx = buffer.indexOf('\n');
    while (idx !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line.startsWith('data:')) {
        const payload = line.slice(5).trim();
        if (payload && payload !== '[DONE]') {
          try {
            const json = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> };
            const delta = json.choices?.[0]?.delta?.content;
            if (delta) yield delta;
          } catch {
            // 跳过不完整分块
          }
        }
      }
      idx = buffer.indexOf('\n');
    }
  }
}

/** OpenAI 兼容 LLM 适配器（chat/completions，支持流式与 JSON 输出）。 */
export const openaiLlmAdapter: LlmAdapter = {
  provider: 'openai',
  async *stream(messages, opts) {
    const { apiKey, model, baseUrl } = llmConfig();
    if (!apiKey) throw new ApiException('model_unavailable', '未配置编排 LLM 密钥');
    const response = await llmFetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: true,
        temperature: opts?.temperature ?? 0.7,
        ...(opts?.maxTokens ? { max_tokens: opts.maxTokens } : {}),
        messages,
      }),
    });
    if (!response.ok || !response.body) {
      throw new ApiException('provider_error', `编排 LLM 流式请求失败（${response.status}）`);
    }
    yield* parseSseDeltas(response.body);
  },
  async complete(messages, opts) {
    const { apiKey, model, baseUrl } = llmConfig();
    if (!apiKey) throw new ApiException('model_unavailable', '未配置编排 LLM 密钥');
    const response = await llmFetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        temperature: opts?.temperature ?? 0.3,
        ...(opts?.maxTokens ? { max_tokens: opts.maxTokens } : {}),
        ...(opts?.json ? { response_format: { type: 'json_object' } } : {}),
        messages,
      }),
    });
    if (!response.ok) {
      throw new ApiException('provider_error', `编排 LLM 请求失败（${response.status}）`);
    }
    const json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return json.choices?.[0]?.message?.content ?? '';
  },
};

/**
 * 取编排 LLM 适配器。当前提供 OpenAI 兼容实现；其它提供商（多走同一 chat/completions
 * 协议，经 ORCHESTRATOR_LLM_BASE_URL 指向）可在此扩展。
 */
export function getLlmAdapter(): LlmAdapter {
  return openaiLlmAdapter;
}
