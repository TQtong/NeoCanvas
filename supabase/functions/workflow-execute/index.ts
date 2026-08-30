/** Flow Studio 公共执行入口。 */

import { type WorkflowExecuteRequest, type WorkflowExecuteResponse } from '../_shared/types.ts';
import {
  ApiException,
  exceptionToResponse,
  fail,
  handleCorsPreflight,
  ok,
} from '../_shared/response.ts';
import { assertProjectOwner, createAdminClient, requireUser } from '../_shared/supabase.ts';
import {
  GENERATION_WORKFLOW_KINDS,
  plannedWorkflowNodeIds,
  rowsToWorkflowGraph,
  validateExecutableWorkflowGraph,
  workflowHash,
} from '../_shared/workflow-runtime.ts';
import { requireAccessibleModel } from '../_shared/models.ts';
import { triggerFunction } from '../_shared/trigger.ts';

function assertEnabled(): void {
  if ((Deno.env.get('FLOW_STUDIO_ENABLED') ?? 'false').toLowerCase() !== 'true') {
    throw new ApiException('not_found', 'Flow Studio 尚未启用');
  }
}

async function assertWorkflowOwner(
  admin: ReturnType<typeof createAdminClient>,
  workflowId: string,
  projectId: string,
  userId: string,
) {
  const { data, error } = await admin.from('workflows').select('*')
    .eq('id', workflowId).eq('project_id', projectId).maybeSingle();
  if (error) throw new ApiException('internal_error', error.message);
  if (!data) throw new ApiException('not_found', '工作流不存在');
  if (data.owner_id !== userId) throw new ApiException('forbidden', '无权访问该工作流');
  return data;
}

function rpcError(message: string): ApiException {
  if (message.includes('WORKFLOW_REVISION_CONFLICT')) {
    return new ApiException('conflict', '工作流已被修改，请刷新后重试');
  }
  if (message.includes('IDEMPOTENCY_CONFLICT')) {
    return new ApiException('idempotency_conflict', '同一幂等键已用于不同运行请求');
  }
  if (message.includes('WORKFLOW_FORBIDDEN')) {
    return new ApiException('forbidden', '无权执行该工作流');
  }
  if (message.includes('NOT_FOUND')) return new ApiException('not_found', '工作流或运行不存在');
  return new ApiException('internal_error', message);
}

async function startRun(
  admin: ReturnType<typeof createAdminClient>,
  body: WorkflowExecuteRequest,
  userId: string,
): Promise<WorkflowExecuteResponse> {
  if (body.expectedGraphRevision === undefined || !body.runMode) {
    throw new ApiException('invalid_params', '启动运行缺少 expectedGraphRevision 或 runMode');
  }
  await assertWorkflowOwner(
    admin,
    body.workflowId,
    body.projectId,
    userId,
  );
  const [{ data: nodes, error: nodeError }, { data: edges, error: edgeError }] = await Promise.all([
    admin.from('workflow_nodes').select('*').eq('workflow_id', body.workflowId),
    admin.from('workflow_edges').select('*').eq('workflow_id', body.workflowId),
  ]);
  if (nodeError || edgeError) {
    throw new ApiException(
      'internal_error',
      nodeError?.message ?? edgeError?.message ?? '读取图失败',
    );
  }
  const graph = rowsToWorkflowGraph(nodes ?? [], edges ?? []);
  const problems = validateExecutableWorkflowGraph(graph);
  if (problems.length > 0) {
    throw new ApiException('invalid_params', '工作流图未通过校验', { problems });
  }
  const plannedIds = plannedWorkflowNodeIds(graph, body.runMode, body.targetNodeId);
  if (plannedIds.length === 0) throw new ApiException('invalid_params', '运行范围为空');

  // 启动前锁定所有模型可访问性；任一不可用即阻断整个 Run，禁止静默 fallback。
  for (
    const node of graph.nodes.filter((item) =>
      plannedIds.includes(item.id) && GENERATION_WORKFLOW_KINDS.has(item.kind)
    )
  ) {
    const modelKey = (node.config as Record<string, unknown>).modelKey;
    if (typeof modelKey !== 'string' || !modelKey) {
      throw new ApiException('model_unavailable', `${node.kind} 未绑定模型`);
    }
    await requireAccessibleModel(
      admin,
      modelKey,
      userId,
      node.kind === 'video_generate' || node.kind === 'sequence_video' ? 'video' : 'image',
    );
  }

  const graphHash = await workflowHash(graph);
  const requestHash = await workflowHash({
    workflowId: body.workflowId,
    revision: body.expectedGraphRevision,
    runMode: body.runMode,
    targetNodeId: body.targetNodeId ?? null,
    force: Boolean(body.force),
    plannedIds: [...plannedIds].sort(),
  });
  const runId = crypto.randomUUID();
  const { data, error } = await admin.rpc('create_workflow_run', {
    p_requester_id: userId,
    p_run_id: runId,
    p_workflow_id: body.workflowId,
    p_expected_graph_revision: body.expectedGraphRevision,
    p_graph_hash: graphHash,
    p_run_mode: body.runMode,
    p_target_node_id: body.targetNodeId ?? null,
    p_force_rerun: Boolean(body.force),
    p_idempotency_key: body.idempotencyKey,
    p_request_hash: requestHash,
    p_planned_node_ids: plannedIds,
  });
  if (error) throw rpcError(error.message);
  const result = data as WorkflowExecuteResponse | null;
  if (!result?.runId) throw new ApiException('internal_error', '创建运行未返回标识');
  if (!result.deduplicated) triggerFunction('process-workflow-queue', { runId: result.runId });
  return result;
}

async function requireRun(
  admin: ReturnType<typeof createAdminClient>,
  runId: string | undefined,
  workflowId: string,
  userId: string,
) {
  if (!runId) throw new ApiException('invalid_params', '缺少 runId');
  const { data, error } = await admin.from('workflow_runs').select('*')
    .eq('id', runId).eq('workflow_id', workflowId).maybeSingle();
  if (error) throw new ApiException('internal_error', error.message);
  if (!data) throw new ApiException('not_found', '运行不存在');
  if (data.requester_id !== userId) throw new ApiException('forbidden', '无权操作该运行');
  return data;
}

async function resumeRun(
  admin: ReturnType<typeof createAdminClient>,
  body: WorkflowExecuteRequest,
  userId: string,
): Promise<WorkflowExecuteResponse> {
  const run = await requireRun(admin, body.runId, body.workflowId, userId);
  if (!body.runNodeId || !body.selectedOutputId) {
    throw new ApiException('invalid_params', '恢复人工选择缺少节点或结果');
  }
  const { data: node } = await admin.from('workflow_run_nodes').select('*')
    .eq('id', body.runNodeId).eq('run_id', run.id).maybeSingle();
  if (!node || node.kind !== 'image_select' || node.status !== 'waiting_user') {
    throw new ApiException('conflict', '节点当前不等待人工选择');
  }
  const { data: links } = await admin.from('workflow_run_input_links')
    .select('source_run_node_id, source_port').eq('target_run_node_id', node.id)
    .eq('target_port', 'images');
  const sourceIds = (links ?? []).map((link) => link.source_run_node_id);
  const { data: selected } = sourceIds.length > 0
    ? await admin.from('workflow_run_outputs').select('id').eq('id', body.selectedOutputId)
      .in('run_node_id', sourceIds).maybeSingle()
    : { data: null };
  if (!selected) throw new ApiException('invalid_params', '所选结果不属于该节点候选');
  const runtime = {
    ...(node.runtime_input as Record<string, unknown>),
    selectedOutputId: selected.id,
  };
  const { error } = await admin.from('workflow_run_nodes').update({
    status: 'pending',
    runtime_input: runtime,
    error: null,
  }).eq('id', node.id).eq('status', 'waiting_user');
  if (error) throw new ApiException('internal_error', error.message);
  await admin.from('workflow_runs').update({ status: 'running', completed_at: null })
    .eq('id', run.id).eq('status', 'waiting_user');
  triggerFunction('process-workflow-queue', { runId: run.id });
  return {
    runId: run.id,
    revisionId: run.revision_id,
    status: 'running',
    deduplicated: false,
  };
}

async function retryRun(
  admin: ReturnType<typeof createAdminClient>,
  body: WorkflowExecuteRequest,
  userId: string,
): Promise<WorkflowExecuteResponse> {
  const run = await requireRun(admin, body.runId, body.workflowId, userId);
  if (!body.runNodeId) throw new ApiException('invalid_params', '重试缺少 runNodeId');
  const [{ data: runNodes }, { data: revisionEdges }] = await Promise.all([
    admin.from('workflow_run_nodes').select('*').eq('run_id', run.id),
    admin.from('workflow_revision_edges').select('*').eq('revision_id', run.revision_id),
  ]);
  const node = (runNodes ?? []).find((item) => item.id === body.runNodeId);
  if (!node) throw new ApiException('not_found', '运行节点不存在');
  const byWorkflowNode = new Map((runNodes ?? []).map((item) => [item.workflow_node_id, item]));
  const resetWorkflowIds = new Set<string>([node.workflow_node_id]);
  const queue = [node.workflow_node_id];
  while (queue.length > 0) {
    const source = queue.shift()!;
    for (const edge of (revisionEdges ?? []).filter((item) => item.source_node_id === source)) {
      if (!byWorkflowNode.has(edge.target_node_id) || resetWorkflowIds.has(edge.target_node_id)) {
        continue;
      }
      resetWorkflowIds.add(edge.target_node_id);
      queue.push(edge.target_node_id);
    }
  }
  const resetNodes = (runNodes ?? []).filter((item) =>
    resetWorkflowIds.has(item.workflow_node_id) &&
    ['failed', 'skipped', 'cancelled'].includes(item.status)
  );
  if (resetNodes.length === 0) throw new ApiException('conflict', '没有可重试的失败节点');
  for (const item of resetNodes) {
    await admin.from('workflow_run_outputs').delete().eq('run_node_id', item.id);
    const runtime = item.runtime_input as Record<string, unknown>;
    await admin.from('workflow_run_nodes').update({
      status: 'pending',
      runtime_input: { ...runtime, attempt: Number(runtime.attempt ?? 0) + 1 },
      error: null,
      completed_at: null,
    }).eq('id', item.id);
  }
  await admin.from('workflow_runs').update({ status: 'running', error: null, completed_at: null })
    .eq('id', run.id);
  triggerFunction('process-workflow-queue', { runId: run.id });
  return {
    runId: run.id,
    revisionId: run.revision_id,
    status: 'running',
    deduplicated: false,
  };
}

async function cancelRun(
  admin: ReturnType<typeof createAdminClient>,
  body: WorkflowExecuteRequest,
  userId: string,
): Promise<WorkflowExecuteResponse> {
  const run = await requireRun(admin, body.runId, body.workflowId, userId);
  await admin.from('workflow_runs').update({
    status: 'cancelled',
    completed_at: new Date().toISOString(),
  }).eq('id', run.id).in('status', ['queued', 'running', 'waiting_user']);
  const { data: nodes } = await admin.from('workflow_run_nodes').select('id').eq('run_id', run.id);
  const ids = (nodes ?? []).map((node) => node.id);
  if (ids.length > 0) {
    await admin.from('workflow_run_nodes').update({
      status: 'cancelled',
      completed_at: new Date().toISOString(),
    }).in('id', ids).in('status', [
      'pending',
      'queued',
      'running',
      'waiting_generation',
      'waiting_user',
    ]);
    await admin.from('generations').update({
      status: 'cancelled',
      error: '工作流运行已取消',
      completed_at: new Date().toISOString(),
    }).in('workflow_run_node_id', ids).in('status', ['pending', 'running']);
  }
  return {
    runId: run.id,
    revisionId: run.revision_id,
    status: 'cancelled',
    deduplicated: false,
  };
}

async function publishOutputs(
  admin: ReturnType<typeof createAdminClient>,
  body: WorkflowExecuteRequest,
  userId: string,
): Promise<WorkflowExecuteResponse> {
  const run = await requireRun(admin, body.runId, body.workflowId, userId);
  if (!body.outputIds?.length) throw new ApiException('invalid_params', '请选择要发布的输出');
  const { data, error } = await admin.rpc('publish_workflow_outputs', {
    p_requester_id: userId,
    p_run_id: run.id,
    p_output_ids: body.outputIds,
  });
  if (error) throw rpcError(error.message);
  const published = data as { nodeIds?: string[] } | null;
  return {
    runId: run.id,
    revisionId: run.revision_id,
    status: run.status,
    deduplicated: false,
    publishedNodeIds: published?.nodeIds ?? [],
  };
}

Deno.serve(async (request) => {
  const preflight = handleCorsPreflight(request);
  if (preflight) return preflight;
  if (request.method !== 'POST') return fail('invalid_params', '仅支持 POST');
  try {
    assertEnabled();
    const { userId } = await requireUser(request);
    const body = await request.json() as WorkflowExecuteRequest;
    if (!body.projectId || !body.workflowId || !body.idempotencyKey || !body.action) {
      throw new ApiException('invalid_params', '缺少工作流执行必要字段');
    }
    const admin = createAdminClient();
    await assertProjectOwner(admin, body.projectId, userId);
    await assertWorkflowOwner(admin, body.workflowId, body.projectId, userId);
    let result: WorkflowExecuteResponse;
    switch (body.action) {
      case 'start':
        result = await startRun(admin, body, userId);
        break;
      case 'resume':
        result = await resumeRun(admin, body, userId);
        break;
      case 'retry':
        result = await retryRun(admin, body, userId);
        break;
      case 'cancel':
        result = await cancelRun(admin, body, userId);
        break;
      case 'publish_output':
        result = await publishOutputs(admin, body, userId);
        break;
      default:
        throw new ApiException('invalid_params', '未知执行动作');
    }
    return ok(result);
  } catch (error) {
    return exceptionToResponse(error);
  }
});
