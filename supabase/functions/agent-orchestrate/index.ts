/**
 * 智能体编排（agent-orchestrate）—— 把对话意图翻译为生成与画布操作（第 05 篇第七节、
 * 第 06 篇第四节）。
 *
 * 流程：先按用户消息去重（同一用户消息只产生一条助手消息与一组生成，重发即回放）；再由
 * 编排型 LLM 产出结构化「编排计划」（助手回复 + 多步骤）；流式回传回复；按计划逐步执行，
 * 每步按其模态选择合适模型、组织参考素材与落位，逐个提交到异步生成流水线，稍后经实时面
 * 落画布。计划由 LLM 驱动，未配置 LLM 时退化为确定性规划（见 orchestrate-plan）。
 *
 * @module functions/agent-orchestrate
 */

import {
  type AgentOrchestrateRequest,
  type GenerationParams,
  type Modality,
  type ModelCatalogRow,
  type ReferenceMaterial,
  type Scene,
  type UnifiedGenerationRequest,
} from '../_shared/types.ts';
import { ApiException, CORS_HEADERS, fail, handleCorsPreflight } from '../_shared/response.ts';
import { assertProjectOwner, createAdminClient, requireUser, type SupabaseClient } from '../_shared/supabase.ts';
import { buildGenerationParams, defaultPlacementSize } from '../_shared/params.ts';
import { buildPlan, type OrchestrationStep } from '../_shared/orchestrate-plan.ts';
import { createGeneration } from '../_shared/create-generation.ts';

/** 流式编码一个 SSE 事件。 */
function sse(event: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

/** 把一段文本切成小块流式回传（计划回复由一次 JSON 规划产出，此处模拟逐块输出）。 */
function* chunkText(text: string, size = 12): Generator<string> {
  for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size);
}

/** 取模型目录当前可服务的产出模态集合。 */
async function getActiveModalities(admin: SupabaseClient): Promise<Modality[]> {
  const { data } = await admin.from('model_catalog').select('modality').eq('is_active', true);
  const set = new Set<Modality>();
  for (const row of (data ?? []) as Array<{ modality: Modality }>) set.add(row.modality);
  return Array.from(set);
}

/** 为某模态选择模型：与用户所选一致则用其，否则取该模态下排序最前的活跃模型。 */
async function pickModelForModality(
  admin: SupabaseClient,
  modality: Modality,
  selectedKey: string,
  selectedModality: Modality,
): Promise<ModelCatalogRow | null> {
  if (modality === selectedModality) {
    const { data } = await admin.from('model_catalog').select('*').eq('key', selectedKey).maybeSingle();
    const row = data as ModelCatalogRow | null;
    if (row && row.is_active) return row;
  }
  const { data } = await admin
    .from('model_catalog')
    .select('*')
    .eq('modality', modality)
    .eq('is_active', true)
    .order('sort_order', { ascending: true })
    .limit(1)
    .maybeSingle();
  return (data as ModelCatalogRow | null) ?? null;
}

/** 由提及节点 + 附件构造某步的参考素材（统一赋予该步的引用角色）。 */
function buildStepReferences(
  body: AgentOrchestrateRequest,
  role: OrchestrationStep['referenceRole'],
): ReferenceMaterial[] {
  return [
    ...body.mentions
      .filter((m) => m.assetId)
      .map<ReferenceMaterial>((m) => ({ origin: 'node', nodeId: m.nodeId, assetId: m.assetId as string, role })),
    ...body.attachments.map<ReferenceMaterial>((a) => ({ origin: 'attachment', assetId: a.assetId, role })),
  ];
}

/** 一条待提交的生成规格（已含模型、参数、尺寸与落位）。 */
interface GenerationSpec {
  modelKey: string;
  modality: Modality;
  prompt: string;
  params: GenerationParams;
  width: number;
  height: number;
}

/** 把编排计划展开为按行居中排布的生成规格序列。 */
async function planToSpecs(
  admin: SupabaseClient,
  body: AgentOrchestrateRequest,
  steps: OrchestrationStep[],
  selectedModality: Modality,
): Promise<GenerationSpec[]> {
  const specs: GenerationSpec[] = [];
  for (const step of steps) {
    const model = await pickModelForModality(admin, step.modality, body.modelKey, selectedModality);
    if (!model) continue; // 目录无法服务该模态则跳过该步
    const references = step.useReferences ? buildStepReferences(body, step.referenceRole) : [];
    const params = buildGenerationParams(step.modality, model.default_params, references);
    const size = defaultPlacementSize(step.modality, 'aspectRatio' in params ? params.aspectRatio : undefined);
    const count = Math.min(step.count, model.capabilities.maxOutputs || step.count);
    for (let i = 0; i < count; i += 1) {
      specs.push({ modelKey: model.key, modality: step.modality, prompt: step.prompt, params, width: size.width, height: size.height });
    }
  }
  return specs;
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

  // 幂等去重：同一用户消息已编排过则回放既有结果，不重复调用 LLM / 不重复建生成
  const { data: existingAssistant } = await admin
    .from('messages')
    .select('id, content')
    .eq('user_message_id', body.messageId)
    .eq('role', 'assistant')
    .maybeSingle();

  let replay: { assistantMessageId: string; content: string; generationIds: string[]; placeholders: Array<{ generationId: string; placeholderNodeId: string }> } | null = null;
  if (existingAssistant) {
    const { data: existingGens } = await admin
      .from('generations')
      .select('id, placeholder_node_id')
      .eq('message_id', body.messageId);
    const gens = (existingGens ?? []) as Array<{ id: string; placeholder_node_id: string | null }>;
    replay = {
      assistantMessageId: existingAssistant.id as string,
      content: (existingAssistant.content as string | null) ?? '',
      generationIds: gens.map((g) => g.id),
      placeholders: gens.map((g) => ({ generationId: g.id, placeholderNodeId: g.placeholder_node_id ?? '' })),
    };
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        // 回放路径：直接重发既有助手消息与生成，保证编排幂等
        if (replay) {
          controller.enqueue(sse({ type: 'message_created', assistantMessageId: replay.assistantMessageId }));
          if (replay.content) controller.enqueue(sse({ type: 'text_delta', delta: replay.content }));
          for (const p of replay.placeholders) {
            controller.enqueue(sse({ type: 'generation_started', generationId: p.generationId, placeholderNodeId: p.placeholderNodeId }));
          }
          controller.enqueue(sse({ type: 'done', assistantMessageId: replay.assistantMessageId, generationIds: replay.generationIds }));
          return;
        }

        const assistantMessageId = crypto.randomUUID();
        controller.enqueue(sse({ type: 'message_created', assistantMessageId }));

        // 取所选模型与场景，构造规划输入
        const { data: model } = await admin
          .from('model_catalog')
          .select('*')
          .eq('key', body.modelKey)
          .maybeSingle();
        const modelRow = model as ModelCatalogRow | null;
        const { data: project } = await admin
          .from('projects')
          .select('initial_scene')
          .eq('id', body.projectId)
          .maybeSingle();
        const scene = (project?.initial_scene as Scene | null) ?? null;

        const selectedModality: Modality = modelRow?.modality ?? 'image';
        const availableModalities = await getActiveModalities(admin);
        const referencesSummary = [
          ...body.mentions.filter((m) => m.assetId).map((m) => ({ label: m.label, kind: m.nodeType })),
          ...body.attachments.map((a) => ({ label: a.name, kind: a.kind })),
        ];

        // 由 LLM 产出编排计划（无 LLM 时确定性兜底）
        const plan = await buildPlan({
          agentMode: body.agentMode,
          content: body.content,
          scene,
          selectedModality,
          maxOutputs: modelRow?.capabilities.maxOutputs ?? 4,
          references: referencesSummary,
          availableModalities,
        });

        // 流式回传助手回复
        for (const piece of chunkText(plan.reply)) {
          controller.enqueue(sse({ type: 'text_delta', delta: piece }));
        }

        // 展开计划为生成规格，居中排布
        const generationIds: string[] = [];
        if (modelRow && modelRow.is_active) {
          const specs = await planToSpecs(admin, body, plan.steps, selectedModality);
          const totalWidth = specs.reduce((sum, s) => sum + s.width + 24, 0) - 24;
          let cursorX = specs.length > 0 ? -totalWidth / 2 : 0;

          for (let idx = 0; idx < specs.length; idx += 1) {
            const spec = specs[idx];
            const genRequest: UnifiedGenerationRequest = {
              projectId: body.projectId,
              conversationId: body.conversationId,
              messageId: body.messageId,
              modality: spec.modality,
              modelKey: spec.modelKey,
              prompt: spec.prompt,
              params: spec.params,
              idempotencyKey: `${body.messageId}-${idx}`,
              placement: { x: cursorX, y: 0, width: spec.width, height: spec.height },
            };
            cursorX += spec.width + 24;
            const result = await createGeneration(admin, genRequest, userId);
            generationIds.push(result.generationId);
            controller.enqueue(
              sse({ type: 'generation_started', generationId: result.generationId, placeholderNodeId: result.placeholderNodeId }),
            );
          }
        }

        // 持久化助手消息（锚定到用户消息以实现去重）；并发冲突则忽略
        const { error: insertError } = await admin.from('messages').insert({
          id: assistantMessageId,
          conversation_id: body.conversationId,
          role: 'assistant',
          content: plan.reply,
          model_key: body.modelKey,
          agent_mode: body.agentMode,
          user_message_id: body.messageId,
        });
        if (insertError && insertError.code !== '23505') {
          throw new ApiException('internal_error', `保存助手消息失败：${insertError.message}`);
        }

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
