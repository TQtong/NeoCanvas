/** 个人模板、模板实例与项目内 Flow App 发布入口。 */

import {
  type FlowAppFieldBinding,
  type FlowAppOutputBinding,
  validateWorkflowGraphStructure,
  type WorkflowGraph,
  type WorkflowPublishRequest,
  type WorkflowPublishResponse,
} from '../_shared/types.ts';
import {
  ApiException,
  exceptionToResponse,
  fail,
  handleCorsPreflight,
  ok,
} from '../_shared/response.ts';
import { assertProjectOwner, createAdminClient, requireUser } from '../_shared/supabase.ts';
import {
  EDGE_APP_EXPOSABLE_PATHS,
  EDGE_WORKFLOW_NODE_DEFINITIONS,
  rowsToWorkflowGraph,
} from '../_shared/workflow-runtime.ts';

async function loadOwnedWorkflow(
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
  const graph = rowsToWorkflowGraph(nodes ?? [], edges ?? []);
  const problems = validateWorkflowGraphStructure(graph, EDGE_WORKFLOW_NODE_DEFINITIONS);
  if (problems.length > 0) {
    throw new ApiException('invalid_params', '模板图未通过结构校验', { problems });
  }
  return { workflow, graph };
}

async function publishTemplate(
  admin: ReturnType<typeof createAdminClient>,
  body: WorkflowPublishRequest,
  userId: string,
): Promise<WorkflowPublishResponse> {
  if (!body.workflowId || !body.name?.trim()) {
    throw new ApiException('invalid_params', '发布模板缺少工作流或名称');
  }
  const { graph } = await loadOwnedWorkflow(
    admin,
    body.workflowId,
    body.projectId,
    userId,
  );
  let templateId = body.templateId;
  let latestVersion = 0;
  if (templateId) {
    const { data } = await admin.from('workflow_templates').select('*')
      .eq('id', templateId).maybeSingle();
    if (!data || data.owner_id !== userId) throw new ApiException('forbidden', '无权更新该模板');
    latestVersion = data.latest_version;
  } else {
    const { data, error } = await admin.from('workflow_templates').insert({
      owner_id: userId,
      name: body.name.trim(),
      description: body.description?.trim() || null,
    }).select('*').single();
    if (error || !data) throw new ApiException('internal_error', error?.message ?? '创建模板失败');
    templateId = data.id;
  }
  const version = latestVersion + 1;
  const { data: versionRow, error: versionError } = await admin
    .from('workflow_template_versions').insert({
      template_id: templateId,
      version,
      graph,
    }).select('*').single();
  if (versionError || !versionRow) {
    throw new ApiException('conflict', versionError?.message ?? '模板版本发布冲突');
  }
  const { error: updateError } = await admin.from('workflow_templates').update({
    name: body.name.trim(),
    description: body.description?.trim() || null,
    latest_version: version,
  }).eq('id', templateId).eq('owner_id', userId);
  if (updateError) throw new ApiException('internal_error', updateError.message);
  return { templateId, templateVersionId: versionRow.id };
}

async function loadTemplateVersion(
  admin: ReturnType<typeof createAdminClient>,
  body: WorkflowPublishRequest,
  userId: string,
): Promise<{
  id: string;
  graph: WorkflowGraph;
  templateInfo: { owner_id?: string; name?: string } | undefined;
}> {
  let versionId = body.templateVersionId;
  if (!versionId && body.templateId) {
    const { data: template } = await admin.from('workflow_templates').select('*')
      .eq('id', body.templateId).maybeSingle();
    if (!template || template.owner_id !== userId) {
      throw new ApiException('forbidden', '无权使用该模板');
    }
    const { data: latest } = await admin.from('workflow_template_versions').select('*')
      .eq('template_id', template.id).eq('version', template.latest_version).maybeSingle();
    versionId = latest?.id;
  }
  if (!versionId) throw new ApiException('invalid_params', '缺少模板版本');
  const { data: version } = await admin.from('workflow_template_versions')
    .select('*, workflow_templates!inner(owner_id, name)').eq('id', versionId).maybeSingle();
  const templateInfo = version?.workflow_templates as
    | { owner_id?: string; name?: string }
    | undefined;
  if (!version || templateInfo?.owner_id !== userId) {
    throw new ApiException('forbidden', '无权使用该模板版本');
  }
  return { ...version, graph: version.graph as WorkflowGraph, templateInfo };
}

async function instantiateTemplate(
  admin: ReturnType<typeof createAdminClient>,
  body: WorkflowPublishRequest,
  userId: string,
): Promise<WorkflowPublishResponse> {
  const version = await loadTemplateVersion(admin, body, userId);
  const { data: workflow, error } = await admin.from('workflows').insert({
    project_id: body.projectId,
    owner_id: userId,
    name: body.name?.trim() || `${version.templateInfo?.name ?? '工作流'} 副本`,
    description: body.description?.trim() || null,
  }).select('*').single();
  if (error || !workflow) {
    throw new ApiException('internal_error', error?.message ?? '创建工作流失败');
  }
  try {
    const idMap = new Map(version.graph.nodes.map((node) => [node.id, crypto.randomUUID()]));
    if (version.graph.nodes.length > 0) {
      const { error: nodeError } = await admin.from('workflow_nodes').insert(
        version.graph.nodes.map((node) => ({
          id: idMap.get(node.id)!,
          workflow_id: workflow.id,
          kind: node.kind,
          position_x: node.position.x,
          position_y: node.position.y,
          config: structuredClone(node.config),
          schema_version: node.schemaVersion,
        })),
      );
      if (nodeError) throw nodeError;
    }
    if (version.graph.edges.length > 0) {
      const { error: edgeError } = await admin.from('workflow_edges').insert(
        version.graph.edges.map((edge) => ({
          id: crypto.randomUUID(),
          workflow_id: workflow.id,
          source_node_id: idMap.get(edge.sourceNodeId)!,
          source_port: edge.sourcePort,
          target_node_id: idMap.get(edge.targetNodeId)!,
          target_port: edge.targetPort,
          value_type: edge.valueType,
        })),
      );
      if (edgeError) throw edgeError;
    }
    return {
      workflowId: workflow.id,
      templateVersionId: version.id,
      nodeIdMap: Object.fromEntries(idMap),
    };
  } catch (error) {
    // 只回滚本请求刚创建的空/部分工作流，不触碰任何既有用户数据。
    await admin.from('workflows').delete().eq('id', workflow.id).eq('owner_id', userId);
    throw new ApiException(
      'internal_error',
      error instanceof Error ? error.message : '实例化模板失败',
    );
  }
}

function validateAppBindings(
  graph: WorkflowGraph,
  fields: FlowAppFieldBinding[],
  outputs: FlowAppOutputBinding[],
): void {
  if (fields.length > 64 || outputs.length > 32) {
    throw new ApiException('invalid_params', 'Flow App 字段或输出数量超过上限');
  }
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const definitions = new Map(EDGE_WORKFLOW_NODE_DEFINITIONS.map((item) => [item.kind, item]));
  const fieldIds = new Set<string>();
  const fieldBindings = new Set<string>();
  for (const field of fields) {
    const node = nodes.get(field.nodeId);
    if (!node || !EDGE_APP_EXPOSABLE_PATHS[node.kind].includes(field.configPath)) {
      throw new ApiException('invalid_params', `字段 ${field.label} 不在节点白名单中`);
    }
    const binding = `${field.nodeId}:${field.configPath}`;
    if (!field.id?.trim() || fieldIds.has(field.id) || fieldBindings.has(binding)) {
      throw new ApiException('invalid_params', 'Flow App 字段 ID 或绑定重复');
    }
    if (!field.label?.trim() || !Number.isInteger(field.order) || field.order < 0) {
      throw new ApiException('invalid_params', 'Flow App 字段标签或顺序非法');
    }
    const defaultValue = field.defaultValue;
    if (
      defaultValue !== null && typeof defaultValue !== 'string' &&
      typeof defaultValue !== 'number' && typeof defaultValue !== 'boolean' &&
      !(Array.isArray(defaultValue) && defaultValue.every((item) => typeof item === 'string'))
    ) {
      throw new ApiException('invalid_params', `字段 ${field.label} 的默认值非法`);
    }
    fieldIds.add(field.id);
    fieldBindings.add(binding);
  }
  const outputBindings = new Set<string>();
  for (const output of outputs) {
    const node = nodes.get(output.nodeId);
    const port = node
      ? definitions.get(node.kind)?.outputs.find((item) => item.id === output.portId)
      : null;
    const binding = `${output.nodeId}:${output.portId}`;
    if (
      !node ||
      !['text_output', 'image_output', 'video_output', 'gallery_output'].includes(node.kind) ||
      !port || outputBindings.has(binding) || !output.label?.trim() ||
      !Number.isInteger(output.order) || output.order < 0
    ) {
      throw new ApiException('invalid_params', `输出 ${output.label} 未绑定有效输出端口`);
    }
    outputBindings.add(binding);
  }
}

async function publishApp(
  admin: ReturnType<typeof createAdminClient>,
  body: WorkflowPublishRequest,
  userId: string,
): Promise<WorkflowPublishResponse> {
  if (!body.name?.trim() || !body.templateVersionId) {
    throw new ApiException('invalid_params', '发布 Flow App 缺少名称或模板版本');
  }
  const version = await loadTemplateVersion(admin, body, userId);
  const fields = body.fields ?? [];
  const outputs = body.outputs ?? [];
  validateAppBindings(version.graph, fields, outputs);
  let flowAppId = body.flowAppId;
  let latestVersion = 0;
  if (flowAppId) {
    const { data } = await admin.from('flow_apps').select('*').eq('id', flowAppId).maybeSingle();
    if (!data || data.owner_id !== userId || data.project_id !== body.projectId) {
      throw new ApiException('forbidden', '无权更新该 Flow App');
    }
    latestVersion = data.latest_version;
  } else {
    const { data, error } = await admin.from('flow_apps').insert({
      owner_id: userId,
      project_id: body.projectId,
      name: body.name.trim(),
      description: body.description?.trim() || null,
    }).select('*').single();
    if (error || !data) {
      throw new ApiException('internal_error', error?.message ?? '创建 Flow App 失败');
    }
    flowAppId = data.id;
  }
  const appVersion = latestVersion + 1;
  const { data: versionRow, error: versionError } = await admin.from('flow_app_versions').insert({
    flow_app_id: flowAppId,
    version: appVersion,
    template_version_id: version.id,
    fields,
    outputs,
  }).select('*').single();
  if (versionError || !versionRow) {
    throw new ApiException('conflict', versionError?.message ?? 'App 版本冲突');
  }
  await admin.from('flow_apps').update({
    name: body.name.trim(),
    description: body.description?.trim() || null,
    latest_version: appVersion,
  }).eq('id', flowAppId);
  return { flowAppId, flowAppVersionId: versionRow.id, templateVersionId: version.id };
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
    const body = await request.json() as WorkflowPublishRequest;
    if (!body.projectId || !body.action) {
      throw new ApiException('invalid_params', '缺少发布必要字段');
    }
    const admin = createAdminClient();
    await assertProjectOwner(admin, body.projectId, userId);
    const result = body.action === 'publish_template'
      ? await publishTemplate(admin, body, userId)
      : body.action === 'instantiate_template'
      ? await instantiateTemplate(admin, body, userId)
      : await publishApp(admin, body, userId);
    return ok(result);
  } catch (error) {
    return exceptionToResponse(error);
  }
});
