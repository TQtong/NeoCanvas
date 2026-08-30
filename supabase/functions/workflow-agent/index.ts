/** Flow Agent：只产生、确认或拒绝结构化图差异，不自动运行。 */

import {
  type WorkflowAgentRequest,
  type WorkflowAgentResponse,
  type WorkflowGraph,
  type WorkflowPatchOperation,
} from '../_shared/types.ts';
import {
  ApiException,
  exceptionToResponse,
  fail,
  handleCorsPreflight,
  ok,
} from '../_shared/response.ts';
import { assertProjectOwner, createAdminClient, requireUser } from '../_shared/supabase.ts';
import { getLlmAdapter, isLlmConfigured } from '../_shared/adapters/text.ts';
import {
  applyWorkflowPatch,
  normalizeWorkflowPatchOperations,
  rowsToWorkflowGraph,
  sanitizeWorkflowPatch,
  validateExecutableWorkflowGraph,
} from '../_shared/workflow-runtime.ts';

async function loadOwnedGraph(
  admin: ReturnType<typeof createAdminClient>,
  workflowId: string,
  projectId: string,
  userId: string,
) {
  const [{ data: workflow }, { data: nodes }, { data: edges }] = await Promise.all([
    admin.from('workflows').select('*').eq('id', workflowId).eq('project_id', projectId)
      .maybeSingle(),
    admin.from('workflow_nodes').select('*').eq('workflow_id', workflowId),
    admin.from('workflow_edges').select('*').eq('workflow_id', workflowId),
  ]);
  if (!workflow) throw new ApiException('not_found', '工作流不存在');
  if (workflow.owner_id !== userId) throw new ApiException('forbidden', '无权访问该工作流');
  return { workflow, graph: rowsToWorkflowGraph(nodes ?? [], edges ?? []) };
}

async function proposeOperations(
  instruction: string,
  graph: WorkflowGraph,
): Promise<WorkflowPatchOperation[]> {
  const deterministicTestMode = Deno.env.get('APP_ENV') === 'test' &&
    Deno.env.get('NEOCANVAS_TEST_MODE') === 'true';
  if (deterministicTestMode || !isLlmConfigured()) {
    const maxX = Math.max(0, ...graph.nodes.map((node) => node.position.x));
    return [{
      op: 'add_node',
      node: {
        id: crypto.randomUUID(),
        kind: 'note',
        position: { x: maxX + 320, y: 80 },
        config: { label: 'Agent 建议', text: instruction },
        schemaVersion: 1,
      },
    }];
  }
  const system = [
    '你是 NeoCanvas Flow Agent。只输出 JSON：{"operations": WorkflowPatchOperation[]}。',
    '允许 op：add_node、update_node_config、move_node、remove_node、add_edge、remove_edge。',
    '禁止运行工作流，禁止涉及运行历史、输出、资产、凭据、代码、HTTP、循环或条件节点。',
    '节点 kind 必须来自当前图已有 kind 或以下集合：text_input,image_input,video_input,mask_input,prompt_template,image_collection,keyframe_collection,image_select,image_generate,image_semantic_edit,image_inpaint,image_outpaint,image_remove_background,image_upscale,video_generate,sequence_video,text_output,image_output,video_output,gallery_output,note。',
    '所有边必须使用真实节点 id 与端口；保持 DAG 且端口类型一致。add_node/add_edge 可用任意临时 id，服务端会改为 UUID。',
    `当前图：${JSON.stringify(graph)}`,
  ].join('\n');
  const raw = await getLlmAdapter().complete(
    [{ role: 'system', content: system }, { role: 'user', content: instruction }],
    { json: true, temperature: 0.2 },
  );
  const parsed = JSON.parse(raw) as { operations?: unknown };
  return normalizeWorkflowPatchOperations(sanitizeWorkflowPatch(parsed.operations), graph);
}

async function propose(
  admin: ReturnType<typeof createAdminClient>,
  body: WorkflowAgentRequest,
  userId: string,
): Promise<WorkflowAgentResponse> {
  if (!body.instruction?.trim()) throw new ApiException('invalid_params', '请输入调整要求');
  const { workflow, graph } = await loadOwnedGraph(
    admin,
    body.workflowId,
    body.projectId,
    userId,
  );
  if (workflow.graph_revision !== body.baseGraphRevision) {
    throw new ApiException('conflict', '工作流已被修改，请刷新后重新提案');
  }
  const operations = await proposeOperations(body.instruction.trim(), graph);
  if (operations.length === 0) throw new ApiException('invalid_params', 'Agent 未产生有效变更');
  const candidate = applyWorkflowPatch(graph, operations);
  const problems = validateExecutableWorkflowGraph(candidate);
  if (problems.length > 0) {
    throw new ApiException('invalid_params', 'Agent 提案未通过图校验', { problems });
  }
  const { data, error } = await admin.from('workflow_patch_proposals').insert({
    workflow_id: body.workflowId,
    requested_by: userId,
    base_graph_revision: body.baseGraphRevision,
    instruction: body.instruction.trim(),
    operations,
  }).select('*').single();
  if (error || !data) throw new ApiException('internal_error', error?.message ?? '保存提案失败');
  return {
    proposalId: data.id,
    status: 'pending',
    operations,
    graphRevision: workflow.graph_revision,
  };
}

async function resolveProposal(
  admin: ReturnType<typeof createAdminClient>,
  body: WorkflowAgentRequest,
  userId: string,
): Promise<WorkflowAgentResponse> {
  if (!body.proposalId) throw new ApiException('invalid_params', '缺少 proposalId');
  const { data: proposal } = await admin.from('workflow_patch_proposals').select('*')
    .eq('id', body.proposalId).eq('workflow_id', body.workflowId).maybeSingle();
  if (!proposal) throw new ApiException('not_found', '提案不存在');
  if (proposal.requested_by !== userId) throw new ApiException('forbidden', '无权处理该提案');
  if (proposal.status !== 'pending') throw new ApiException('conflict', '提案已处理');
  if (body.action === 'reject') {
    const { error } = await admin.from('workflow_patch_proposals').update({
      status: 'rejected',
      resolved_at: new Date().toISOString(),
    }).eq('id', proposal.id).eq('status', 'pending');
    if (error) throw new ApiException('internal_error', error.message);
    return {
      proposalId: proposal.id,
      status: 'rejected',
      operations: proposal.operations,
      graphRevision: proposal.base_graph_revision,
    };
  }

  const { graph } = await loadOwnedGraph(admin, body.workflowId, body.projectId, userId);
  const candidate = applyWorkflowPatch(graph, proposal.operations);
  const problems = validateExecutableWorkflowGraph(candidate);
  if (problems.length > 0) {
    throw new ApiException('invalid_params', '提案在应用前校验失败', { problems });
  }
  const { data, error } = await admin.rpc('apply_workflow_patch', {
    p_requester_id: userId,
    p_proposal_id: proposal.id,
  });
  if (error) {
    if (error.message.includes('REVISION_CONFLICT')) {
      throw new ApiException('conflict', '工作流已变化，提案不能应用');
    }
    if (error.message.includes('EXPIRED')) throw new ApiException('conflict', '提案已过期');
    throw new ApiException('internal_error', error.message);
  }
  const result = data as { graphRevision?: number } | null;
  return {
    proposalId: proposal.id,
    status: 'applied',
    operations: proposal.operations,
    graphRevision: result?.graphRevision ?? body.baseGraphRevision,
  };
}

Deno.serve(async (request) => {
  const preflight = handleCorsPreflight(request);
  if (preflight) return preflight;
  if (request.method !== 'POST') return fail('invalid_params', '仅支持 POST');
  try {
    if ((Deno.env.get('FLOW_STUDIO_ENABLED') ?? 'false').toLowerCase() !== 'true') {
      throw new ApiException('not_found', 'Flow Studio 尚未启用');
    }
    const { userId } = await requireUser(request);
    const body = await request.json() as WorkflowAgentRequest;
    if (!body.projectId || !body.workflowId || !body.action) {
      throw new ApiException('invalid_params', '缺少 Agent 必要字段');
    }
    const admin = createAdminClient();
    await assertProjectOwner(admin, body.projectId, userId);
    const result = body.action === 'propose'
      ? await propose(admin, body, userId)
      : await resolveProposal(admin, body, userId);
    return ok(result);
  } catch (error) {
    return exceptionToResponse(error);
  }
});
