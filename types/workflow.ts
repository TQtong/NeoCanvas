/**
 * Flow Studio 跨前端、数据库与 Edge Function 的共享契约。
 *
 * 工作流图只允许显式的强类型端口；配置与运行均固定到不可变修订，避免编辑中的图影响
 * 已经启动的执行。此模块不依赖浏览器或 Node API，可确定性生成到 Edge 运行时。
 *
 * @module types/workflow
 */

/** Flow 端口允许传递的值类型。 */
export const FLOW_VALUE_TYPES = [
  'text',
  'number',
  'boolean',
  'image_asset',
  'video_asset',
  'mask_asset',
  'image_list',
  'keyframe_list',
] as const;

/** Flow 端口值类型。 */
export type FlowValueType = (typeof FLOW_VALUE_TYPES)[number];

/** v0.3 支持的节点种类。 */
export const WORKFLOW_NODE_KINDS = [
  'text_input',
  'image_input',
  'video_input',
  'mask_input',
  'prompt_template',
  'image_collection',
  'keyframe_collection',
  'image_select',
  'image_generate',
  'image_semantic_edit',
  'image_inpaint',
  'image_outpaint',
  'image_remove_background',
  'image_upscale',
  'video_generate',
  'sequence_video',
  'text_output',
  'image_output',
  'video_output',
  'gallery_output',
  'note',
] as const;

/** Flow 节点种类。 */
export type WorkflowNodeKind = (typeof WORKFLOW_NODE_KINDS)[number];

/** 工作流运行状态。 */
export const WORKFLOW_RUN_STATUSES = [
  'queued',
  'running',
  'waiting_user',
  'succeeded',
  'partial',
  'failed',
  'cancelled',
] as const;
export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number];

/** 单节点运行状态。 */
export const WORKFLOW_RUN_NODE_STATUSES = [
  'pending',
  'cached',
  'queued',
  'running',
  'waiting_generation',
  'waiting_user',
  'succeeded',
  'failed',
  'skipped',
  'cancelled',
] as const;
export type WorkflowRunNodeStatus = (typeof WORKFLOW_RUN_NODE_STATUSES)[number];

/** 图端口定义。 */
export interface WorkflowPortDefinition {
  id: string;
  label: string;
  valueType: FlowValueType;
  required: boolean;
  multiple: boolean;
}

/** 节点在图上的公共配置。 */
export interface WorkflowNodeConfigBase {
  label?: string;
}

/** 文本输入。 */
export interface TextInputConfig extends WorkflowNodeConfigBase {
  value: string;
}

/** 单资产输入。 */
export interface AssetInputConfig extends WorkflowNodeConfigBase {
  assetId: string | null;
}

/** Prompt 模板；变量使用 `{{inputPort}}`。 */
export interface PromptTemplateConfig extends WorkflowNodeConfigBase {
  template: string;
}

/** 资产集合节点。 */
export interface AssetCollectionConfig extends WorkflowNodeConfigBase {
  assetIds: string[];
}

/** 图片选择节点。 */
export interface ImageSelectConfig extends WorkflowNodeConfigBase {
  mode: 'manual' | 'fixed';
  selectedIndex: number;
}

/** 图片生成公共设置。 */
export interface ImageGenerateConfig extends WorkflowNodeConfigBase {
  modelKey: string | null;
  count: number;
  aspectRatio: string;
  width?: number;
  height?: number;
  quality?: 'low' | 'medium' | 'high' | 'auto';
}

/** 图片编辑公共设置。 */
export interface ImageEditConfig extends ImageGenerateConfig {
  inputMode: 'original' | 'flattened';
  inputFidelity?: 'standard' | 'high';
}

/** 局部重绘设置。 */
export interface ImageInpaintConfig extends ImageEditConfig {
  maskFeatherPx: number;
}

/** 扩图设置。 */
export interface ImageOutpaintConfig extends ImageEditConfig {
  outputWidth: number;
  outputHeight: number;
  sourceX: number;
  sourceY: number;
}

/** 放大设置。 */
export interface ImageUpscaleConfig extends ImageEditConfig {
  factor: 2 | 4;
}

/** 视频生成设置。 */
export interface VideoGenerateConfig extends WorkflowNodeConfigBase {
  modelKey: string | null;
  durationSec: number;
  resolution: string;
  aspectRatio: string;
  fps: number;
  motionStrength?: number;
}

/** 注释节点。 */
export interface NoteConfig extends WorkflowNodeConfigBase {
  text: string;
}

/** 所有节点配置的联合。种类与具体配置的配对由节点注册表校验。 */
export type WorkflowNodeConfig =
  | TextInputConfig
  | AssetInputConfig
  | PromptTemplateConfig
  | AssetCollectionConfig
  | ImageSelectConfig
  | ImageGenerateConfig
  | ImageEditConfig
  | ImageInpaintConfig
  | ImageOutpaintConfig
  | ImageUpscaleConfig
  | VideoGenerateConfig
  | NoteConfig
  | WorkflowNodeConfigBase;

/** 可持久化的工作流节点。 */
export interface WorkflowGraphNode {
  id: string;
  kind: WorkflowNodeKind;
  position: { x: number; y: number };
  config: WorkflowNodeConfig;
  schemaVersion: number;
}

/** 可持久化的工作流边。 */
export interface WorkflowGraphEdge {
  id: string;
  sourceNodeId: string;
  sourcePort: string;
  targetNodeId: string;
  targetPort: string;
  valueType: FlowValueType;
}

/** 完整工作流图。 */
export interface WorkflowGraph {
  nodes: WorkflowGraphNode[];
  edges: WorkflowGraphEdge[];
}

/** 图校验问题。 */
export interface WorkflowValidationProblem {
  code:
    | 'duplicate_node'
    | 'duplicate_edge'
    | 'missing_node'
    | 'missing_port'
    | 'type_mismatch'
    | 'duplicate_input'
    | 'required_input'
    | 'cycle'
    | 'invalid_config';
  message: string;
  nodeId?: string;
  edgeId?: string;
  portId?: string;
}

/** 节点注册表中图校验所需的最小投影。 */
export interface WorkflowNodeDefinitionLike {
  kind: WorkflowNodeKind;
  inputs: WorkflowPortDefinition[];
  outputs: WorkflowPortDefinition[];
}

/**
 * 校验引用、端口、类型、输入基数、必需输入与 DAG 环路。
 * 配置 Schema 由运行时节点注册表追加校验。
 */
export function validateWorkflowGraphStructure(
  graph: WorkflowGraph,
  definitions: readonly WorkflowNodeDefinitionLike[],
): WorkflowValidationProblem[] {
  const problems: WorkflowValidationProblem[] = [];
  const nodeMap = new Map<string, WorkflowGraphNode>();
  const definitionMap = new Map(definitions.map((definition) => [definition.kind, definition]));
  for (const node of graph.nodes) {
    if (nodeMap.has(node.id)) {
      problems.push({ code: 'duplicate_node', nodeId: node.id, message: `节点 ${node.id} 重复` });
    }
    nodeMap.set(node.id, node);
  }

  const edgeIds = new Set<string>();
  const incoming = new Map<string, WorkflowGraphEdge[]>();
  for (const edge of graph.edges) {
    if (edgeIds.has(edge.id)) {
      problems.push({ code: 'duplicate_edge', edgeId: edge.id, message: `边 ${edge.id} 重复` });
    }
    edgeIds.add(edge.id);
    const source = nodeMap.get(edge.sourceNodeId);
    const target = nodeMap.get(edge.targetNodeId);
    if (!source || !target) {
      problems.push({
        code: 'missing_node',
        edgeId: edge.id,
        message: `边 ${edge.id} 引用了不存在的节点`,
      });
      continue;
    }
    const sourcePort = definitionMap
      .get(source.kind)
      ?.outputs.find((port) => port.id === edge.sourcePort);
    const targetPort = definitionMap
      .get(target.kind)
      ?.inputs.find((port) => port.id === edge.targetPort);
    if (!sourcePort || !targetPort) {
      problems.push({
        code: 'missing_port',
        edgeId: edge.id,
        message: `边 ${edge.id} 引用了不存在的端口`,
      });
      continue;
    }
    if (sourcePort.valueType !== targetPort.valueType || edge.valueType !== sourcePort.valueType) {
      problems.push({
        code: 'type_mismatch',
        edgeId: edge.id,
        message: `边 ${edge.id} 的端口类型不一致`,
      });
    }
    const key = `${edge.targetNodeId}:${edge.targetPort}`;
    const list = incoming.get(key) ?? [];
    list.push(edge);
    incoming.set(key, list);
    if (!targetPort.multiple && list.length > 1) {
      problems.push({
        code: 'duplicate_input',
        nodeId: target.id,
        portId: targetPort.id,
        message: `${targetPort.label} 只允许一个输入`,
      });
    }
  }

  for (const node of graph.nodes) {
    const definition = definitionMap.get(node.kind);
    for (const port of definition?.inputs ?? []) {
      if (port.required && !(incoming.get(`${node.id}:${port.id}`)?.length ?? 0)) {
        problems.push({
          code: 'required_input',
          nodeId: node.id,
          portId: port.id,
          message: `${port.label} 缺少输入`,
        });
      }
    }
  }

  if (topologicalWorkflowNodeIds(graph).length !== graph.nodes.length) {
    problems.push({ code: 'cycle', message: '工作流必须是无环图' });
  }
  return problems;
}

/** 返回稳定拓扑序；存在环路时只返回能够确定顺序的部分。 */
export function topologicalWorkflowNodeIds(graph: WorkflowGraph): string[] {
  const ids = new Set(graph.nodes.map((node) => node.id));
  const indegree = new Map(Array.from(ids, (id) => [id, 0]));
  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (!ids.has(edge.sourceNodeId) || !ids.has(edge.targetNodeId)) continue;
    indegree.set(edge.targetNodeId, (indegree.get(edge.targetNodeId) ?? 0) + 1);
    const targets = outgoing.get(edge.sourceNodeId) ?? [];
    targets.push(edge.targetNodeId);
    outgoing.set(edge.sourceNodeId, targets);
  }
  const ready = Array.from(ids)
    .filter((id) => indegree.get(id) === 0)
    .sort();
  const ordered: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    ordered.push(id);
    for (const target of outgoing.get(id) ?? []) {
      const next = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, next);
      if (next === 0) {
        ready.push(target);
        ready.sort();
      }
    }
  }
  return ordered;
}

/** 返回一个或多个节点的全部下游节点（包含起点）。 */
export function workflowDescendants(graph: WorkflowGraph, startNodeIds: string[]): Set<string> {
  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const targets = outgoing.get(edge.sourceNodeId) ?? [];
    targets.push(edge.targetNodeId);
    outgoing.set(edge.sourceNodeId, targets);
  }
  const result = new Set(startNodeIds);
  const queue = [...startNodeIds];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const target of outgoing.get(id) ?? []) {
      if (result.has(target)) continue;
      result.add(target);
      queue.push(target);
    }
  }
  return result;
}

/** Flow Agent 唯一允许提出的图变更。 */
export type WorkflowPatchOperation =
  | { op: 'add_node'; node: WorkflowGraphNode }
  | { op: 'update_node_config'; nodeId: string; config: WorkflowNodeConfig }
  | { op: 'move_node'; nodeId: string; position: { x: number; y: number } }
  | { op: 'remove_node'; nodeId: string }
  | { op: 'add_edge'; edge: WorkflowGraphEdge }
  | { op: 'remove_edge'; edgeId: string };

/** Flow App 表单字段绑定。 */
export interface FlowAppFieldBinding {
  id: string;
  nodeId: string;
  configPath: string;
  label: string;
  description?: string;
  order: number;
  required: boolean;
  defaultValue: string | number | boolean | string[] | null;
}

/** Flow App 输出绑定。 */
export interface FlowAppOutputBinding {
  nodeId: string;
  portId: string;
  label: string;
  order: number;
}

/** 执行动作。 */
export type WorkflowExecuteAction = 'start' | 'resume' | 'retry' | 'cancel' | 'publish_output';

/** 工作流执行请求。 */
export interface WorkflowExecuteRequest {
  action: WorkflowExecuteAction;
  projectId: string;
  workflowId: string;
  expectedGraphRevision?: number;
  idempotencyKey: string;
  runMode?: 'node' | 'downstream' | 'all';
  targetNodeId?: string;
  force?: boolean;
  runId?: string;
  runNodeId?: string;
  selectedOutputId?: string;
  outputIds?: string[];
}

/** 工作流执行响应。 */
export interface WorkflowExecuteResponse {
  runId: string;
  status: WorkflowRunStatus;
  revisionId: string;
  deduplicated: boolean;
  publishedNodeIds?: string[];
}

/** Agent 请求。 */
export interface WorkflowAgentRequest {
  action: 'propose' | 'apply' | 'reject';
  projectId: string;
  workflowId: string;
  baseGraphRevision: number;
  instruction?: string;
  proposalId?: string;
}

/** Agent 响应。 */
export interface WorkflowAgentResponse {
  proposalId: string;
  status: 'pending' | 'applied' | 'rejected' | 'expired';
  operations: WorkflowPatchOperation[];
  graphRevision: number;
}

/** 模板与 Flow App 发布请求。 */
export interface WorkflowPublishRequest {
  action: 'publish_template' | 'instantiate_template' | 'publish_app';
  projectId: string;
  workflowId?: string;
  templateId?: string;
  templateVersionId?: string;
  flowAppId?: string;
  name?: string;
  description?: string;
  fields?: FlowAppFieldBinding[];
  outputs?: FlowAppOutputBinding[];
}

/** 模板与 Flow App 发布响应。 */
export interface WorkflowPublishResponse {
  workflowId?: string;
  nodeIdMap?: Record<string, string>;
  templateId?: string;
  templateVersionId?: string;
  flowAppId?: string;
  flowAppVersionId?: string;
}
