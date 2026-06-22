/**
 * 智能体编排（agent-orchestrate）—— 把对话意图翻译为生成与画布操作（第 05 篇第七节、
 * 第 06 篇第四节）。
 *
 * 按 Agent 模式呈现不同深度：纯生成直接转为一次生成提交；编排式先以语言模型理解意图、
 * 再组织一到多次生成并决定落位；场景流程加载场景模板产出成套物料。助手文本回复经
 * SSE 流式返回，图 / 视频走异步生成流水线稍后经实时面落画布。
 *
 * @module functions/agent-orchestrate
 */

import {
  type AgentOrchestrateRequest,
  type ModelCatalogRow,
  type ReferenceMaterial,
  type Scene,
  type UnifiedGenerationRequest,
} from '../_shared/types.ts';
import { ApiException, CORS_HEADERS, fail, handleCorsPreflight } from '../_shared/response.ts';
import { assertProjectOwner, createAdminClient, requireUser } from '../_shared/supabase.ts';
import {
  buildGenerationParams,
  composeScenePrompt,
  defaultPlacementSize,
  sceneGenerationCount,
} from '../_shared/params.ts';
import { createGeneration } from '../_shared/create-generation.ts';

/** 流式编码一个 SSE 事件。 */
function sse(event: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

/** 调用编排型 LLM 流式生成文本回复；无密钥时回退为本地化定语。 */
async function* llmReply(
  mode: AgentOrchestrateRequest['agentMode'],
  content: string,
): AsyncGenerator<string> {
  const apiKey = Deno.env.get('ORCHESTRATOR_LLM_API_KEY') ?? Deno.env.get('OPENAI_API_KEY');
  const model = Deno.env.get('ORCHESTRATOR_LLM_MODEL') ?? 'gpt-4o-mini';

  if (mode === 'orchestrate' && apiKey) {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: true,
        messages: [
          {
            role: 'system',
            content:
              '你是 NeoCanvas 的设计编排助手。用简洁中文先确认理解用户的视觉意图（要生成什么、风格、数量），再说明将如何在画布上落位。不要超过 3 句。',
          },
          { role: 'user', content },
        ],
      }),
    });
    if (response.ok && response.body) {
      const reader = response.body.getReader();
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
                const json = JSON.parse(payload) as {
                  choices?: Array<{ delta?: { content?: string } }>;
                };
                const delta = json.choices?.[0]?.delta?.content;
                if (delta) yield delta;
              } catch {
                // 忽略不完整分块
              }
            }
          }
          idx = buffer.indexOf('\n');
        }
      }
      return;
    }
  }

  // 回退：本地化定语
  const canned =
    mode === 'scene'
      ? '正在按所选场景为你产出成套物料，请稍候。'
      : mode === 'orchestrate'
        ? '正在理解你的想法并编排生成，请稍候。'
        : '好的，正在为你生成。';
  for (const ch of canned) {
    yield ch;
  }
}

/** 从内容粗略解析期望产出数量（编排模式）。 */
function parseCount(content: string): number {
  const cnMap: Record<string, number> = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4 };
  const cn = content.match(/[一二两三四]/)?.[0];
  if (cn && cnMap[cn]) return Math.min(cnMap[cn], 4);
  const digit = content.match(/([1-9])\s*(?:张|个|版|幅)/)?.[1];
  if (digit) return Math.min(Number(digit), 4);
  return 1;
}

Deno.serve(async (request) => {
  const preflight = handleCorsPreflight(request);
  if (preflight) return preflight;
  if (request.method !== 'POST') return fail('invalid_params', '仅支持 POST');

  let userId: string;
  let body: AgentOrchestrateRequest;
  const admin = createAdminClient();
  try {
    const auth = await requireUser(request);
    userId = auth.userId;
    body = (await request.json()) as AgentOrchestrateRequest;
    await assertProjectOwner(admin, body.projectId, userId);
  } catch (error) {
    return error instanceof ApiException
      ? fail(error.code, error.message, error.details)
      : fail('internal_error', '编排初始化失败');
  }

  const assistantMessageId = crypto.randomUUID();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let fullText = '';
      const generationIds: string[] = [];
      try {
        controller.enqueue(sse({ type: 'message_created', assistantMessageId }));

        // 1) 流式文本回复
        for await (const delta of llmReply(body.agentMode, body.content)) {
          fullText += delta;
          controller.enqueue(sse({ type: 'text_delta', delta }));
        }

        // 2) 取模型与场景
        const { data: model } = await admin
          .from('model_catalog')
          .select('*')
          .eq('key', body.modelKey)
          .maybeSingle();
        const modelRow = model as ModelCatalogRow | null;

        // 模态取自所选模型（请求不携带 modality）
        if (modelRow && modelRow.is_active) {
          const { data: project } = await admin
            .from('projects')
            .select('initial_scene')
            .eq('id', body.projectId)
            .maybeSingle();
          const scene = (project?.initial_scene as Scene | null) ?? null;

          // 3) 决定产出数量
          const count =
            body.agentMode === 'scene'
              ? sceneGenerationCount(scene)
              : body.agentMode === 'orchestrate'
                ? parseCount(body.content)
                : 1;

          // 4) 参考素材（提及节点 + 附件）
          const references: ReferenceMaterial[] = [
            ...body.mentions
              .filter((m) => m.assetId)
              .map<ReferenceMaterial>((m) => ({
                origin: 'node',
                nodeId: m.nodeId,
                assetId: m.assetId as string,
                role: modelRow.modality === 'video' ? 'first_frame' : 'content',
              })),
            ...body.attachments.map<ReferenceMaterial>((a) => ({
              origin: 'attachment',
              assetId: a.assetId,
              role: modelRow.modality === 'video' ? 'first_frame' : 'content',
            })),
          ];

          const params = buildGenerationParams(modelRow.modality, modelRow.default_params, references);
          const size = defaultPlacementSize(
            modelRow.modality,
            'aspectRatio' in params ? params.aspectRatio : undefined,
          );
          const startX = -((count * (size.width + 24) - 24) / 2);
          const effectivePrompt =
            body.agentMode === 'scene' ? composeScenePrompt(scene, body.content) : body.content;

          // 5) 逐个创建生成（网格排布）
          for (let i = 0; i < count; i += 1) {
            const genRequest: UnifiedGenerationRequest = {
              projectId: body.projectId,
              conversationId: body.conversationId,
              messageId: body.messageId,
              modality: modelRow.modality,
              modelKey: body.modelKey,
              prompt: effectivePrompt,
              params,
              idempotencyKey: `${body.messageId}-${i}`,
              placement: {
                x: startX + i * (size.width + 24),
                y: 0,
                width: size.width,
                height: size.height,
              },
            };
            const result = await createGeneration(admin, genRequest, userId);
            generationIds.push(result.generationId);
            controller.enqueue(
              sse({
                type: 'generation_started',
                generationId: result.generationId,
                placeholderNodeId: result.placeholderNodeId,
              }),
            );
          }
        }

        // 6) 持久化助手消息
        await admin.from('messages').insert({
          id: assistantMessageId,
          conversation_id: body.conversationId,
          role: 'assistant',
          content: fullText,
          model_key: body.modelKey,
          agent_mode: body.agentMode,
        });

        controller.enqueue(sse({ type: 'done', assistantMessageId, generationIds }));
      } catch (error) {
        const code = error instanceof ApiException ? error.code : 'internal_error';
        const message = error instanceof Error ? error.message : '编排失败';
        controller.enqueue(sse({ type: 'error', code, message }));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
});
