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
import {
  assertProjectOwner,
  createAdminClient,
  requireUser,
  type SupabaseClient,
} from '../_shared/supabase.ts';
import { buildGenerationParams, defaultPlacementSize } from '../_shared/params.ts';
import { buildPlan, type OrchestrationStep } from '../_shared/orchestrate-plan.ts';
import {
  buildPosterLayout,
  buildPosterTextNodeRows,
  detectPosterIntent,
  POSTER_ASPECT_RATIO,
  posterPlacement,
} from '../_shared/poster.ts';
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
    const { data } = await admin
      .from('model_catalog')
      .select('*')
      .eq('key', selectedKey)
      .maybeSingle();
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
      .map<ReferenceMaterial>((m) => ({
        origin: 'node',
        nodeId: m.nodeId,
        assetId: m.assetId as string,
        role,
      })),
    ...body.attachments.map<ReferenceMaterial>((a) => ({
      origin: 'attachment',
      assetId: a.assetId,
      role,
    })),
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

/** 新一批生成与既有画布内容之间的水平间距（flow px）。 */
const CANVAS_BATCH_GAP = 64;

/**
 * 计算「新一批生成」应起始的 x：取项目内既有节点的最右缘 + 间距，使新内容落在既有内容右侧的
 * 空白处，而非每次都以原点居中、彼此堆叠（多次生成只显示一张的根因）。
 *
 * 画布为空（项目首次生成）时返回 null，由调用方按本批宽度以原点居中——保持首图居中的体验。
 *
 * @param admin - 服务角色客户端
 * @param projectId - 项目标识
 * @returns 新批次最左缘 x；画布为空时为 null
 */
async function nextBatchStartX(admin: SupabaseClient, projectId: string): Promise<number | null> {
  const { data } = await admin
    .from('canvas_nodes')
    .select('position_x, width')
    .eq('project_id', projectId);
  const rows = (data ?? []) as Array<{ position_x: number | null; width: number | null }>;
  if (rows.length === 0) return null;
  let maxRight = -Infinity;
  for (const r of rows) maxRight = Math.max(maxRight, (r.position_x ?? 0) + (r.width ?? 0));
  return Number.isFinite(maxRight) ? maxRight + CANVAS_BATCH_GAP : null;
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
    const size = defaultPlacementSize(
      step.modality,
      'aspectRatio' in params ? params.aspectRatio : undefined,
    );
    const count = Math.min(step.count, model.capabilities.maxOutputs || step.count);
    for (let i = 0; i < count; i += 1) {
      specs.push({
        modelKey: model.key,
        modality: step.modality,
        prompt: step.prompt,
        params,
        width: size.width,
        height: size.height,
      });
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

  let replay: {
    assistantMessageId: string;
    content: string;
    generationIds: string[];
    placeholders: Array<{ generationId: string; placeholderNodeId: string }>;
  } | null = null;
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
      placeholders: gens.map((g) => ({
        generationId: g.id,
        placeholderNodeId: g.placeholder_node_id ?? '',
      })),
    };
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        // 回放路径：直接重发既有助手消息与生成，保证编排幂等
        if (replay) {
          controller.enqueue(
            sse({ type: 'message_created', assistantMessageId: replay.assistantMessageId }),
          );
          if (replay.content)
            controller.enqueue(sse({ type: 'text_delta', delta: replay.content }));
          for (const p of replay.placeholders) {
            controller.enqueue(
              sse({
                type: 'generation_started',
                generationId: p.generationId,
                placeholderNodeId: p.placeholderNodeId,
              }),
            );
          }
          controller.enqueue(
            sse({
              type: 'done',
              assistantMessageId: replay.assistantMessageId,
              generationIds: replay.generationIds,
            }),
          );
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

        // 海报意图：走「分层合成」——生成「无文字的版式化背景图」并叠加可编辑文字节点，
        // 而非把文字烤进图里（原始文生图模型渲染中文文字不可靠，见 _shared/poster.ts）。
        if (
          detectPosterIntent(body.content) &&
          selectedModality === 'image' &&
          modelRow &&
          modelRow.is_active
        ) {
          const layout = await buildPosterLayout(body.content, scene);
          for (const piece of chunkText(layout.reply)) {
            controller.enqueue(sse({ type: 'text_delta', delta: piece }));
          }

          // 背景图：竖版、显式无文字；落在既有画布内容右侧的空白处（画布为空则居中），
          // 避免多次生成的海报堆叠在同一处。文字节点相对 placement 计算，随之一并偏移。
          const posterBase = posterPlacement();
          const posterStartX = await nextBatchStartX(admin, body.projectId);
          const placement = posterStartX === null ? posterBase : { ...posterBase, x: posterStartX };
          const params = buildGenerationParams(
            'image',
            { ...modelRow.default_params, aspectRatio: POSTER_ASPECT_RATIO },
            [],
          );
          const genRequest: UnifiedGenerationRequest = {
            projectId: body.projectId,
            conversationId: body.conversationId,
            messageId: body.messageId,
            modality: 'image',
            modelKey: body.modelKey,
            prompt: layout.backgroundPrompt,
            params,
            idempotencyKey: body.messageId,
            placement,
          };
          const bg = await createGeneration(admin, genRequest, userId);
          controller.enqueue(
            sse({
              type: 'generation_started',
              generationId: bg.generationId,
              placeholderNodeId: bg.placeholderNodeId,
            }),
          );

          // 文字节点（z≥10，叠在背景之上；稳定 id + upsert，连点/重试不重复建）
          const textRows = buildPosterTextNodeRows(
            layout,
            placement,
            body.projectId,
            userId,
            body.messageId,
          );
          if (textRows.length > 0) {
            const { error: nodesError } = await admin
              .from('canvas_nodes')
              .upsert(textRows, { onConflict: 'id' });
            if (nodesError) {
              throw new ApiException(
                'internal_error',
                `创建海报文字节点失败：${nodesError.message}`,
              );
            }
          }

          // 持久化助手消息（锚定用户消息以去重）；并发冲突忽略
          const { error: posterMsgError } = await admin.from('messages').insert({
            id: assistantMessageId,
            conversation_id: body.conversationId,
            role: 'assistant',
            content: layout.reply,
            model_key: body.modelKey,
            agent_mode: body.agentMode,
            user_message_id: body.messageId,
          });
          if (posterMsgError && posterMsgError.code !== '23505') {
            throw new ApiException('internal_error', `保存助手消息失败：${posterMsgError.message}`);
          }

          controller.enqueue(
            sse({ type: 'done', assistantMessageId, generationIds: [bg.generationId] }),
          );
          return;
        }

        const availableModalities = await getActiveModalities(admin);
        const referencesSummary = [
          ...body.mentions
            .filter((m) => m.assetId)
            .map((m) => ({ label: m.label, kind: m.nodeType })),
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
          // 新一批落在既有画布内容右侧的空白处；画布为空（首次生成）则按批宽以原点居中
          const batchStartX = await nextBatchStartX(admin, body.projectId);
          let cursorX = batchStartX ?? (specs.length > 0 ? -totalWidth / 2 : 0);

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
              sse({
                type: 'generation_started',
                generationId: result.generationId,
                placeholderNodeId: result.placeholderNodeId,
              }),
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
