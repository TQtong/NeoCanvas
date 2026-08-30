/** Flow Studio 内部消费者：推进纯节点、缓存、人工等待与媒体生成。 */

import {
  type FlowValueType,
  type ReferenceMaterial,
  type UnifiedGenerationRequest,
  type WorkflowNodeKind,
  type WorkflowRunNodeStatus,
} from '../_shared/types.ts';
import { exceptionToResponse, fail, ok } from '../_shared/response.ts';
import { createAdminClient, type SupabaseClient } from '../_shared/supabase.ts';
import { requireInternalServiceRole } from '../_shared/internal-auth.ts';
import {
  createWorkflowGeneration,
  workflowImageOperation,
} from '../_shared/create-workflow-generation.ts';
import {
  forceRerunWorkflowNodeIds,
  GENERATION_WORKFLOW_KINDS,
  workflowHash,
} from '../_shared/workflow-runtime.ts';

interface RunRow {
  id: string;
  workflow_id: string;
  project_id: string;
  requester_id: string;
  status: string;
  revision_id: string;
  run_mode: 'node' | 'downstream' | 'all';
  target_node_id: string | null;
  force_rerun: boolean;
}

interface RunNodeRow {
  id: string;
  run_id: string;
  workflow_node_id: string;
  kind: WorkflowNodeKind;
  status: WorkflowRunNodeStatus;
  config_snapshot: Record<string, unknown>;
  cache_key: string | null;
  runtime_input: Record<string, unknown>;
}

interface OutputRow {
  id: string;
  run_node_id: string;
  port_id: string;
  value_type: FlowValueType;
  asset_id: string | null;
  value: unknown;
  ordinal: number;
}

interface LinkRow {
  source_run_node_id: string;
  source_port: string;
  target_run_node_id: string;
  target_port: string;
  ordinal: number;
}

interface ResolvedInput extends OutputRow {
  targetPort: string;
  linkOrdinal: number;
}

const SUCCESS_STATUSES = new Set<WorkflowRunNodeStatus>(['succeeded', 'cached', 'skipped']);
const TERMINAL_NODE_STATUSES = new Set<WorkflowRunNodeStatus>([
  'succeeded',
  'cached',
  'failed',
  'skipped',
  'cancelled',
]);

/** 将未知值安全收敛为字符串。 */
function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/** 将未知值安全收敛为有限数字。 */
function numberValue(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function inputsForNode(
  nodeId: string,
  links: LinkRow[],
  outputs: OutputRow[],
): ResolvedInput[] {
  const outputMap = new Map<string, OutputRow[]>();
  for (const output of outputs) {
    const key = `${output.run_node_id}:${output.port_id}`;
    const list = outputMap.get(key) ?? [];
    list.push(output);
    outputMap.set(key, list);
  }
  return links
    .filter((link) => link.target_run_node_id === nodeId)
    .flatMap((link) =>
      (outputMap.get(`${link.source_run_node_id}:${link.source_port}`) ?? []).map((output) => ({
        ...output,
        targetPort: link.target_port,
        linkOrdinal: link.ordinal,
      }))
    )
    .sort((left, right) => left.linkOrdinal - right.linkOrdinal || left.ordinal - right.ordinal);
}

/** 输入、输出等纯节点的确定性结果。null 表示进入人工等待。 */
function executePureNode(
  node: RunNodeRow,
  inputs: ResolvedInput[],
): Array<Omit<OutputRow, 'id' | 'run_node_id'>> | null {
  const config = node.config_snapshot;
  const output = (
    portId: string,
    valueType: FlowValueType,
    value: unknown,
    assetId: string | null,
    ordinal = 0,
  ): Omit<OutputRow, 'id' | 'run_node_id'> => ({
    port_id: portId,
    value_type: valueType,
    value,
    asset_id: assetId,
    ordinal,
  });

  switch (node.kind) {
    case 'text_input':
      return [output('text', 'text', stringValue(config.value), null)];
    case 'image_input':
      return [output('image', 'image_asset', null, stringValue(config.assetId) || null)];
    case 'video_input':
      return [output('video', 'video_asset', null, stringValue(config.assetId) || null)];
    case 'mask_input':
      return [output('mask', 'mask_asset', null, stringValue(config.assetId) || null)];
    case 'prompt_template': {
      const values = inputs
        .filter((input) => input.targetPort === 'variables')
        .map((input) => stringValue(input.value));
      const joined = values.join('\n');
      let cursor = 0;
      const template = stringValue(config.template);
      const rendered = template.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_match, name: string) => {
        if (name.trim() === 'variables') return joined;
        const value = values[cursor];
        cursor += 1;
        if (value === undefined) throw new Error(`Prompt 变量 ${name.trim()} 缺少输入`);
        return value;
      });
      return [output('text', 'text', rendered, null)];
    }
    case 'image_collection':
    case 'keyframe_collection': {
      const fixed = Array.isArray(config.assetIds)
        ? config.assetIds.filter((item): item is string => typeof item === 'string')
        : [];
      const incoming = inputs.flatMap((input) => input.asset_id ? [input.asset_id] : []);
      const assets = [...fixed, ...incoming];
      const portId = node.kind === 'keyframe_collection' ? 'keyframes' : 'images';
      const valueType = node.kind === 'keyframe_collection' ? 'keyframe_list' : 'image_list';
      return assets.map((assetId, ordinal) => output(portId, valueType, null, assetId, ordinal));
    }
    case 'image_select': {
      const candidates = inputs.filter((input) => input.targetPort === 'images' && input.asset_id);
      if (candidates.length === 0) throw new Error('图片选择节点没有候选资产');
      const selectedOutputId = stringValue(node.runtime_input.selectedOutputId);
      if (config.mode === 'manual' && !selectedOutputId) return null;
      const selected = selectedOutputId
        ? candidates.find((candidate) => candidate.id === selectedOutputId)
        : candidates[Math.max(0, Math.floor(numberValue(config.selectedIndex, 0)))];
      if (!selected?.asset_id) throw new Error('选择的图片不存在');
      return [output('image', 'image_asset', null, selected.asset_id)];
    }
    case 'text_output':
      return [output('text', 'text', inputs[0]?.value ?? '', null)];
    case 'image_output':
      return [output('image', 'image_asset', null, inputs[0]?.asset_id ?? null)];
    case 'video_output':
      return [output('video', 'video_asset', null, inputs[0]?.asset_id ?? null)];
    case 'gallery_output':
      return inputs.map((input, ordinal) =>
        output('images', 'image_list', null, input.asset_id, ordinal)
      );
    case 'note':
      return [];
    default:
      throw new Error(`节点 ${node.kind} 不是纯节点`);
  }
}

function reference(assetId: string, role: ReferenceMaterial['role']): ReferenceMaterial {
  return { origin: 'attachment', assetId, role };
}

/** 把媒体节点配置和已解析输入映射为既有统一生成契约。 */
function generationRequest(
  run: RunRow,
  node: RunNodeRow,
  inputs: ResolvedInput[],
): UnifiedGenerationRequest {
  const config = node.config_snapshot;
  const modelKey = stringValue(config.modelKey);
  const prompt = stringValue(inputs.find((input) => input.targetPort === 'prompt')?.value);
  const asset = (port: string) =>
    inputs.find((input) => input.targetPort === port)?.asset_id ?? null;
  const attempt = Math.max(0, Math.floor(numberValue(node.runtime_input.attempt, 0)));
  const common = {
    projectId: run.project_id,
    conversationId: null,
    messageId: null,
    modelKey,
    prompt,
    idempotencyKey: `${run.id}:${node.id}:${attempt}`,
    resultMode: 'workflow_output' as const,
  };

  if (node.kind === 'video_generate' || node.kind === 'sequence_video') {
    const firstFrame = asset('first_frame');
    const keyframes = inputs
      .filter((input) => input.targetPort === 'keyframes' && input.asset_id)
      .map((input) => reference(input.asset_id!, 'keyframe'));
    return {
      ...common,
      modality: 'video',
      params: {
        modality: 'video',
        durationSec: numberValue(config.durationSec, 5),
        resolution: stringValue(config.resolution, '720p'),
        aspectRatio: stringValue(config.aspectRatio, '16:9') as '16:9',
        fps: numberValue(config.fps, 24),
        motionStrength: numberValue(config.motionStrength, 0.5),
        references: firstFrame ? [reference(firstFrame, 'first_frame')] : [],
        ...(node.kind === 'sequence_video' ? { keyframes } : {}),
      },
    };
  }

  const operation = workflowImageOperation(node.kind);
  const source = asset('image');
  const mask = asset('mask');
  const references: ReferenceMaterial[] = [];
  if (source) references.push(reference(source, 'content'));
  if (mask) references.push(reference(mask, 'mask'));
  const params: Record<string, unknown> = {
    modality: 'image',
    operation,
    count: operation === 'remove_background' || operation === 'upscale'
      ? 1
      : numberValue(config.count, 1),
    aspectRatio: stringValue(config.aspectRatio, '1:1'),
    quality: stringValue(config.quality, 'auto'),
    references,
  };
  if (operation !== 'generate') {
    params.inputMode = stringValue(config.inputMode, 'original');
    if (config.inputFidelity) params.inputFidelity = config.inputFidelity;
  }
  if (operation === 'inpaint') params.maskFeatherPx = numberValue(config.maskFeatherPx, 8);
  if (operation === 'outpaint') {
    params.outputCanvas = {
      width: numberValue(config.outputWidth, 1536),
      height: numberValue(config.outputHeight, 1536),
      sourceX: numberValue(config.sourceX, 256),
      sourceY: numberValue(config.sourceY, 256),
      sourceWidth: numberValue(config.width, 1024),
      sourceHeight: numberValue(config.height, 1024),
    };
  }
  if (operation === 'remove_background') params.background = 'transparent';
  if (operation === 'upscale') params.upscaleFactor = numberValue(config.factor, 2);
  return {
    ...common,
    modality: 'image',
    params: params as unknown as UnifiedGenerationRequest['params'],
  };
}

async function cloneCache(
  admin: SupabaseClient,
  run: RunRow,
  node: RunNodeRow,
  cacheKey: string,
  bypassCache: boolean,
): Promise<boolean> {
  if (bypassCache) return false;
  const { data: candidates } = await admin
    .from('workflow_run_nodes')
    .select('id, run_id')
    .eq('cache_key', cacheKey)
    .in('status', ['succeeded', 'cached'])
    .neq('id', node.id)
    .order('completed_at', { ascending: false })
    .limit(20);
  if (!candidates?.length) return false;
  const { data: validRuns } = await admin
    .from('workflow_runs')
    .select('id')
    .eq('workflow_id', run.workflow_id)
    .in('id', candidates.map((candidate) => candidate.run_id));
  const valid = new Set((validRuns ?? []).map((item) => item.id));
  const source = candidates.find((candidate) => valid.has(candidate.run_id));
  if (!source) return false;
  const { data: sourceOutputs } = await admin
    .from('workflow_run_outputs')
    .select('*')
    .eq('run_node_id', source.id)
    .order('ordinal');
  if (!sourceOutputs) return false;
  const assetIds = sourceOutputs.flatMap((item) => item.asset_id ? [item.asset_id] : []);
  if (assetIds.length > 0) {
    const { data: assets } = await admin.from('assets').select('id').in('id', assetIds);
    if ((assets ?? []).length !== new Set(assetIds).size) return false;
  }
  if (sourceOutputs.length > 0) {
    const { error } = await admin.from('workflow_run_outputs').insert(
      sourceOutputs.map((item) => ({
        run_node_id: node.id,
        port_id: item.port_id,
        value_type: item.value_type,
        asset_id: item.asset_id,
        value: item.value,
        ordinal: item.ordinal,
      })),
    );
    if (error) throw error;
  }
  const { error } = await admin.from('workflow_run_nodes').update({
    status: 'cached',
    cache_key: cacheKey,
    cache_source_run_node_id: source.id,
    completed_at: new Date().toISOString(),
  }).eq('id', node.id).eq('status', 'running');
  if (error) throw error;
  return true;
}

async function processRun(admin: SupabaseClient, runId: string): Promise<void> {
  const { data: rawRun } = await admin.from('workflow_runs').select('*').eq('id', runId)
    .maybeSingle();
  if (!rawRun || ['succeeded', 'partial', 'failed', 'cancelled'].includes(rawRun.status)) return;
  const run = rawRun as RunRow;
  await admin.from('workflow_runs').update({ status: 'running' }).eq('id', run.id).eq(
    'status',
    'queued',
  );

  const [{ data: plannedRows }, { data: revisionEdges }] = await Promise.all([
    admin.from('workflow_run_nodes').select('workflow_node_id').eq('run_id', run.id),
    admin.from('workflow_revision_edges').select('source_node_id, target_node_id')
      .eq('revision_id', run.revision_id),
  ]);
  const forcedNodeIds = forceRerunWorkflowNodeIds(
    (plannedRows ?? []).map((item) => item.workflow_node_id),
    revisionEdges ?? [],
    run.run_mode,
    run.target_node_id,
    run.force_rerun,
  );
  const nonCacheableKinds = new Set<WorkflowNodeKind>(['image_select', 'note']);

  for (let pass = 0; pass < 100; pass += 1) {
    const [{ data: rawNodes }, { data: rawLinks }, { data: rawOutputs }] = await Promise.all([
      admin.from('workflow_run_nodes').select('*').eq('run_id', run.id),
      admin.from('workflow_run_input_links').select('*').eq('run_id', run.id).order('ordinal'),
      admin.from('workflow_run_outputs').select('*, workflow_run_nodes!inner(run_id)')
        .eq('workflow_run_nodes.run_id', run.id),
    ]);
    const nodes = (rawNodes ?? []) as RunNodeRow[];
    const links = (rawLinks ?? []) as LinkRow[];
    const outputs = (rawOutputs ?? []) as OutputRow[];
    const byId = new Map(nodes.map((node) => [node.id, node]));
    let progressed = false;

    for (const node of nodes.filter((item) => item.status === 'pending')) {
      const upstreamIds = links
        .filter((link) => link.target_run_node_id === node.id)
        .map((link) => link.source_run_node_id);
      const upstream = upstreamIds.map((id) => byId.get(id)).filter((item): item is RunNodeRow =>
        Boolean(item)
      );
      if (upstream.some((item) => ['failed', 'cancelled'].includes(item.status))) {
        await admin.from('workflow_run_nodes').update({
          status: 'skipped',
          error: '上游节点失败或取消',
          completed_at: new Date().toISOString(),
        }).eq('id', node.id).eq('status', 'pending');
        progressed = true;
        continue;
      }
      if (!upstream.every((item) => SUCCESS_STATUSES.has(item.status))) continue;

      const { data: claimed } = await admin.from('workflow_run_nodes').update({
        status: 'running',
        started_at: new Date().toISOString(),
        error: null,
      }).eq('id', node.id).eq('status', 'pending').select('*').maybeSingle();
      if (!claimed) continue;
      progressed = true;
      const current = claimed as RunNodeRow;
      const inputs = inputsForNode(current.id, links, outputs);
      try {
        let providerSnapshot: string | null = null;
        const modelKey = stringValue(current.config_snapshot.modelKey);
        if (modelKey) {
          const { data: model } = await admin.from('model_catalog')
            .select('key, provider, default_params').eq('key', modelKey).eq('is_active', true)
            .maybeSingle();
          const defaults = model?.default_params as Record<string, unknown> | undefined;
          const providerModel = typeof defaults?.providerModel === 'string'
            ? defaults.providerModel
            : model?.key;
          providerSnapshot = model
            ? `${model.provider}:${providerModel}`
            : `unavailable:${modelKey}`;
        }
        const cacheKey = await workflowHash({
          workflowId: run.workflow_id,
          kind: current.kind,
          schemaVersion: 1,
          executorVersion: '1',
          config: current.config_snapshot,
          inputs: inputs.map((input) => ({
            port: input.targetPort,
            type: input.value_type,
            assetId: input.asset_id,
            value: input.value,
            ordinal: input.ordinal,
          })),
          modelKey,
          resolvedProviderModel: providerSnapshot,
        });
        const bypassCache = forcedNodeIds.has(current.workflow_node_id) ||
          nonCacheableKinds.has(current.kind);
        if (await cloneCache(admin, run, current, cacheKey, bypassCache)) continue;

        if (GENERATION_WORKFLOW_KINDS.has(current.kind)) {
          const request = generationRequest(run, current, inputs);
          await createWorkflowGeneration(admin, current.id, request, run.requester_id);
          await admin.from('workflow_run_nodes').update({ cache_key: cacheKey })
            .eq('id', current.id).eq('status', 'waiting_generation');
          continue;
        }

        const result = executePureNode(current, inputs);
        if (result === null) {
          await admin.from('workflow_run_nodes').update({
            status: 'waiting_user',
            cache_key: cacheKey,
          })
            .eq('id', current.id).eq('status', 'running');
          continue;
        }
        if (result.length > 0) {
          const { error } = await admin.from('workflow_run_outputs').insert(
            result.map((item) => ({ ...item, run_node_id: current.id })),
          );
          if (error) throw error;
        }
        const { error } = await admin.from('workflow_run_nodes').update({
          status: current.kind === 'note' ? 'skipped' : 'succeeded',
          cache_key: cacheKey,
          completed_at: new Date().toISOString(),
        }).eq('id', current.id).eq('status', 'running');
        if (error) throw error;
      } catch (error) {
        await admin.from('workflow_run_nodes').update({
          status: 'failed',
          error: error instanceof Error ? error.message : '节点执行失败',
          completed_at: new Date().toISOString(),
        }).eq('id', current.id).in('status', ['running', 'waiting_generation']);
      }
    }
    if (!progressed) break;
  }

  const { data: finalRows } = await admin.from('workflow_run_nodes').select('status').eq(
    'run_id',
    run.id,
  );
  const statuses = (finalRows ?? []).map((item) => item.status as WorkflowRunNodeStatus);
  let status: 'running' | 'waiting_user' | 'succeeded' | 'partial' | 'failed' = 'running';
  let completedAt: string | null = null;
  if (statuses.some((item) => item === 'waiting_user')) status = 'waiting_user';
  else if (statuses.some((item) => !TERMINAL_NODE_STATUSES.has(item))) status = 'running';
  else {
    const failed = statuses.some((item) => item === 'failed' || item === 'cancelled');
    const succeeded = statuses.some((item) => item === 'succeeded' || item === 'cached');
    status = failed ? succeeded ? 'partial' : 'failed' : 'succeeded';
    completedAt = new Date().toISOString();
  }
  await admin.from('workflow_runs').update({ status, completed_at: completedAt })
    .eq('id', run.id).neq('status', 'cancelled');
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return fail('invalid_params', '仅支持 POST');
  try {
    requireInternalServiceRole(request);
    if ((Deno.env.get('FLOW_STUDIO_ENABLED') ?? 'false').toLowerCase() !== 'true') {
      return ok({ processed: 0, disabled: true });
    }
    const admin = createAdminClient();
    const body = await request.json().catch(() => ({})) as { runId?: string; runNodeId?: string };
    const runIds: string[] = [];
    if (body.runId) runIds.push(body.runId);
    if (!body.runId && body.runNodeId) {
      const { data } = await admin.from('workflow_run_nodes').select('run_id')
        .eq('id', body.runNodeId).maybeSingle();
      if (data?.run_id) runIds.push(data.run_id);
    }
    if (runIds.length === 0) {
      const { data } = await admin.from('workflow_runs').select('id')
        .in('status', ['queued', 'running']).order('created_at').limit(5);
      runIds.push(...(data ?? []).map((item) => item.id));
    }
    for (const runId of runIds) await processRun(admin, runId);
    return ok({ processed: runIds.length });
  } catch (error) {
    return exceptionToResponse(error);
  }
});
