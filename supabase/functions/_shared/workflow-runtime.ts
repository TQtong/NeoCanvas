/** Flow Studio Edge 侧图校验、Patch 和执行计划共享逻辑。 */

import {
  type FlowValueType,
  validateWorkflowGraphStructure,
  workflowDescendants,
  type WorkflowGraph,
  type WorkflowGraphEdge,
  type WorkflowGraphNode,
  type WorkflowNodeDefinitionLike,
  type WorkflowNodeKind,
  type WorkflowPatchOperation,
  type WorkflowValidationProblem,
} from './types.ts';

const p = (
  id: string,
  valueType: FlowValueType,
  required = false,
  multiple = false,
) => ({ id, label: id, valueType, required, multiple });

/** 与根节点注册表端口逐字一致的 Edge 校验投影。 */
export const EDGE_WORKFLOW_NODE_DEFINITIONS: readonly WorkflowNodeDefinitionLike[] = [
  { kind: 'text_input', inputs: [], outputs: [p('text', 'text', true)] },
  { kind: 'image_input', inputs: [], outputs: [p('image', 'image_asset', true)] },
  { kind: 'video_input', inputs: [], outputs: [p('video', 'video_asset', true)] },
  { kind: 'mask_input', inputs: [], outputs: [p('mask', 'mask_asset', true)] },
  {
    kind: 'prompt_template',
    inputs: [p('variables', 'text', false, true)],
    outputs: [p('text', 'text', true)],
  },
  {
    kind: 'image_collection',
    inputs: [p('images', 'image_asset', false, true)],
    outputs: [p('images', 'image_list', true)],
  },
  {
    kind: 'keyframe_collection',
    inputs: [p('images', 'image_asset', false, true)],
    outputs: [p('keyframes', 'keyframe_list', true)],
  },
  {
    kind: 'image_select',
    inputs: [p('images', 'image_list', true)],
    outputs: [p('image', 'image_asset', true)],
  },
  {
    kind: 'image_generate',
    inputs: [p('prompt', 'text', true)],
    outputs: [p('images', 'image_list', true)],
  },
  ...(['image_semantic_edit', 'image_outpaint'] as const).map(
    (kind) => ({
      kind,
      inputs: [p('image', 'image_asset', true), p('prompt', 'text')],
      outputs: [p('images', 'image_list', true)],
    }),
  ),
  {
    kind: 'image_remove_background',
    inputs: [p('image', 'image_asset', true)],
    outputs: [p('image', 'image_asset', true)],
  },
  {
    kind: 'image_inpaint',
    inputs: [
      p('image', 'image_asset', true),
      p('mask', 'mask_asset', true),
      p('prompt', 'text', true),
    ],
    outputs: [p('images', 'image_list', true)],
  },
  {
    kind: 'image_upscale',
    inputs: [p('image', 'image_asset', true)],
    outputs: [p('image', 'image_asset', true)],
  },
  {
    kind: 'video_generate',
    inputs: [p('prompt', 'text', true), p('first_frame', 'image_asset')],
    outputs: [p('video', 'video_asset', true)],
  },
  {
    kind: 'sequence_video',
    inputs: [p('prompt', 'text'), p('keyframes', 'keyframe_list', true)],
    outputs: [p('video', 'video_asset', true)],
  },
  {
    kind: 'text_output',
    inputs: [p('text', 'text', true)],
    outputs: [p('text', 'text', true)],
  },
  {
    kind: 'image_output',
    inputs: [p('image', 'image_asset', true)],
    outputs: [p('image', 'image_asset', true)],
  },
  {
    kind: 'video_output',
    inputs: [p('video', 'video_asset', true)],
    outputs: [p('video', 'video_asset', true)],
  },
  {
    kind: 'gallery_output',
    inputs: [p('images', 'image_list', true)],
    outputs: [p('images', 'image_list', true)],
  },
  { kind: 'note', inputs: [], outputs: [] },
];

const definitionMap = new Map(EDGE_WORKFLOW_NODE_DEFINITIONS.map((item) => [item.kind, item]));

/** 媒体模型节点。 */
export const GENERATION_WORKFLOW_KINDS = new Set<WorkflowNodeKind>([
  'image_generate',
  'image_semantic_edit',
  'image_inpaint',
  'image_outpaint',
  'image_remove_background',
  'image_upscale',
  'video_generate',
  'sequence_video',
]);

/** 注册表可供 Flow App 暴露的配置路径。 */
export const EDGE_APP_EXPOSABLE_PATHS: Readonly<Record<WorkflowNodeKind, readonly string[]>> = {
  text_input: ['value'],
  image_input: ['assetId'],
  video_input: ['assetId'],
  mask_input: ['assetId'],
  prompt_template: ['template'],
  image_collection: ['assetIds'],
  keyframe_collection: ['assetIds'],
  image_select: ['mode', 'selectedIndex'],
  image_generate: ['count', 'aspectRatio', 'width', 'height', 'quality'],
  image_semantic_edit: ['count', 'aspectRatio', 'quality', 'inputFidelity'],
  image_inpaint: ['count', 'quality', 'maskFeatherPx'],
  image_outpaint: ['outputWidth', 'outputHeight', 'sourceX', 'sourceY', 'quality'],
  image_remove_background: ['count', 'aspectRatio', 'quality', 'inputFidelity'],
  image_upscale: ['factor'],
  video_generate: ['durationSec', 'resolution', 'aspectRatio', 'fps', 'motionStrength'],
  sequence_video: ['durationSec', 'resolution', 'fps', 'motionStrength'],
  text_output: [],
  image_output: [],
  video_output: [],
  gallery_output: [],
  note: [],
};

/** 追加 Edge 可执行性校验：配置对象、输入资产与精确模型绑定。 */
export function validateExecutableWorkflowGraph(graph: WorkflowGraph): WorkflowValidationProblem[] {
  const problems = validateWorkflowGraphStructure(graph, EDGE_WORKFLOW_NODE_DEFINITIONS);
  for (const node of graph.nodes) {
    const config = node.config as Record<string, unknown>;
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      problems.push({ code: 'invalid_config', nodeId: node.id, message: '节点配置必须是对象' });
      continue;
    }
    if (GENERATION_WORKFLOW_KINDS.has(node.kind)) {
      if (typeof config.modelKey !== 'string' || !config.modelKey.trim()) {
        problems.push({
          code: 'invalid_config',
          nodeId: node.id,
          message: '生成节点必须精确绑定模型',
        });
      }
    }
    if (['image_input', 'video_input', 'mask_input'].includes(node.kind)) {
      if (typeof config.assetId !== 'string' || !config.assetId) {
        problems.push({ code: 'invalid_config', nodeId: node.id, message: '资产输入不能为空' });
      }
    }
    if (node.kind === 'text_input' && typeof config.value !== 'string') {
      problems.push({ code: 'invalid_config', nodeId: node.id, message: '文本输入无效' });
    }
  }
  return problems;
}

/** 取目标节点全部上游（包含自身）。 */
export function workflowAncestors(graph: WorkflowGraph, startNodeIds: string[]): Set<string> {
  const incoming = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const sources = incoming.get(edge.targetNodeId) ?? [];
    sources.push(edge.sourceNodeId);
    incoming.set(edge.targetNodeId, sources);
  }
  const result = new Set(startNodeIds);
  const queue = [...startNodeIds];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const source of incoming.get(id) ?? []) {
      if (result.has(source)) continue;
      result.add(source);
      queue.push(source);
    }
  }
  return result;
}

/** 按运行模式得到包含必需上游的执行集合。 */
export function plannedWorkflowNodeIds(
  graph: WorkflowGraph,
  mode: 'node' | 'downstream' | 'all',
  targetNodeId?: string,
): string[] {
  if (mode === 'all') return graph.nodes.map((node) => node.id);
  if (!targetNodeId || !graph.nodes.some((node) => node.id === targetNodeId)) return [];
  const targets = mode === 'downstream'
    ? workflowDescendants(graph, [targetNodeId])
    : new Set([targetNodeId]);
  return Array.from(workflowAncestors(graph, Array.from(targets)));
}

/** 计算强制重跑范围；为补齐依赖而加入计划的祖先仍可命中缓存。 */
export function forceRerunWorkflowNodeIds(
  nodeIds: string[],
  edges: Array<{ source_node_id: string; target_node_id: string }>,
  mode: 'node' | 'downstream' | 'all',
  targetNodeId: string | null,
  force: boolean,
): Set<string> {
  if (!force) return new Set();
  if (mode === 'all') return new Set(nodeIds);
  if (!targetNodeId || !nodeIds.includes(targetNodeId)) return new Set();
  const result = new Set([targetNodeId]);
  if (mode === 'node') return result;
  const queue = [targetNodeId];
  while (queue.length > 0) {
    const source = queue.shift()!;
    for (const edge of edges) {
      if (edge.source_node_id !== source || result.has(edge.target_node_id)) continue;
      result.add(edge.target_node_id);
      queue.push(edge.target_node_id);
    }
  }
  return result;
}

/** 把当前数据库行投影为共享图。 */
export function rowsToWorkflowGraph(
  nodes: Array<{
    id: string;
    kind: WorkflowNodeKind;
    position_x: number;
    position_y: number;
    config: Record<string, unknown>;
    schema_version: number;
  }>,
  edges: Array<{
    id: string;
    source_node_id: string;
    source_port: string;
    target_node_id: string;
    target_port: string;
    value_type: FlowValueType;
  }>,
): WorkflowGraph {
  return {
    nodes: nodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      position: { x: node.position_x, y: node.position_y },
      config: node.config,
      schemaVersion: node.schema_version,
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      sourceNodeId: edge.source_node_id,
      sourcePort: edge.source_port,
      targetNodeId: edge.target_node_id,
      targetPort: edge.target_port,
      valueType: edge.value_type,
    })),
  };
}

/** 在内存中应用 Agent Patch；不修改输入图。 */
export function applyWorkflowPatch(
  graph: WorkflowGraph,
  operations: WorkflowPatchOperation[],
): WorkflowGraph {
  const nodes = new Map(graph.nodes.map((node) => [node.id, structuredClone(node)]));
  const edges = new Map(graph.edges.map((edge) => [edge.id, structuredClone(edge)]));
  for (const operation of operations) {
    switch (operation.op) {
      case 'add_node':
        nodes.set(operation.node.id, structuredClone(operation.node));
        break;
      case 'update_node_config': {
        const node = nodes.get(operation.nodeId);
        if (node) node.config = structuredClone(operation.config);
        break;
      }
      case 'move_node': {
        const node = nodes.get(operation.nodeId);
        if (node) node.position = { ...operation.position };
        break;
      }
      case 'remove_node':
        nodes.delete(operation.nodeId);
        for (const [id, edge] of edges) {
          if (edge.sourceNodeId === operation.nodeId || edge.targetNodeId === operation.nodeId) {
            edges.delete(id);
          }
        }
        break;
      case 'add_edge':
        edges.set(operation.edge.id, structuredClone(operation.edge));
        break;
      case 'remove_edge':
        edges.delete(operation.edgeId);
        break;
    }
  }
  return { nodes: Array.from(nodes.values()), edges: Array.from(edges.values()) };
}

/** 获取端口定义。 */
export function workflowPort(
  kind: WorkflowNodeKind,
  direction: 'input' | 'output',
  portId: string,
) {
  const definition = definitionMap.get(kind);
  return (direction === 'input' ? definition?.inputs : definition?.outputs)?.find(
    (item) => item.id === portId,
  );
}

/** 图和请求的稳定 SHA-256。 */
export async function workflowHash(value: unknown): Promise<string> {
  const canonicalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonicalize);
    if (item && typeof item === 'object') {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .filter(([, entry]) => entry !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => [key, canonicalize(entry)]),
      );
    }
    return item;
  };
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalize(value)));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Edge 功能开关，默认关闭。 */
export function assertFlowStudioEnabled(): void {
  if ((Deno.env.get('FLOW_STUDIO_ENABLED') ?? 'false').toLowerCase() !== 'true') {
    throw new Error('FLOW_STUDIO_DISABLED');
  }
}

/** 仅接受共享契约中的 Patch 形状，丢弃 LLM 额外字段。 */
export function sanitizeWorkflowPatch(raw: unknown): WorkflowPatchOperation[] {
  if (!Array.isArray(raw)) return [];
  const operations: WorkflowPatchOperation[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const candidate = item as Record<string, unknown>;
    const op = candidate.op;
    if (op === 'add_node' && candidate.node && typeof candidate.node === 'object') {
      const node = candidate.node as WorkflowGraphNode;
      if (typeof node.id === 'string' && definitionMap.has(node.kind)) {
        operations.push({ op, node });
      }
    } else if (
      op === 'update_node_config' && typeof candidate.nodeId === 'string' &&
      candidate.config && typeof candidate.config === 'object'
    ) {
      operations.push({ op, nodeId: candidate.nodeId, config: candidate.config });
    } else if (
      op === 'move_node' && typeof candidate.nodeId === 'string' &&
      candidate.position && typeof candidate.position === 'object'
    ) {
      operations.push({
        op,
        nodeId: candidate.nodeId,
        position: candidate.position as { x: number; y: number },
      });
    } else if (op === 'remove_node' && typeof candidate.nodeId === 'string') {
      operations.push({ op, nodeId: candidate.nodeId });
    } else if (op === 'add_edge' && candidate.edge && typeof candidate.edge === 'object') {
      operations.push({ op, edge: candidate.edge as WorkflowGraphEdge });
    } else if (op === 'remove_edge' && typeof candidate.edgeId === 'string') {
      operations.push({ op, edgeId: candidate.edgeId });
    }
  }
  return operations.slice(0, 100);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

/**
 * 把 Agent 可读的临时节点/边 ID 重映射为 UUID，并同步改写同一 Patch 内的全部引用。
 * 已存在或重复 ID 永远不会覆盖当前图实体。
 */
export function normalizeWorkflowPatchOperations(
  operations: WorkflowPatchOperation[],
  graph: WorkflowGraph,
  createId: () => string = () => crypto.randomUUID(),
): WorkflowPatchOperation[] {
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const edgeIds = new Set(graph.edges.map((edge) => edge.id));
  const nodeIdByOperation = new Map<WorkflowPatchOperation, string>();
  const edgeIdByOperation = new Map<WorkflowPatchOperation, string>();
  const nodeReferences = new Map<string, string>();
  const edgeReferences = new Map<string, string>();

  for (const operation of operations) {
    if (operation.op === 'add_node') {
      const proposed = operation.node.id;
      const id = isUuid(proposed) && !nodeIds.has(proposed) ? proposed : createId();
      nodeIds.add(id);
      nodeIdByOperation.set(operation, id);
      if (!nodeReferences.has(proposed)) nodeReferences.set(proposed, id);
    } else if (operation.op === 'add_edge') {
      const proposed = operation.edge.id;
      const id = isUuid(proposed) && !edgeIds.has(proposed) ? proposed : createId();
      edgeIds.add(id);
      edgeIdByOperation.set(operation, id);
      if (!edgeReferences.has(proposed)) edgeReferences.set(proposed, id);
    }
  }

  const resolveNode = (id: string) => nodeReferences.get(id) ?? id;
  return operations.flatMap((operation): WorkflowPatchOperation[] => {
    if (operation.op === 'add_node') {
      return [{
        op: 'add_node',
        node: {
          ...operation.node,
          id: nodeIdByOperation.get(operation)!,
          position: {
            x: Number.isFinite(operation.node.position?.x) ? operation.node.position.x : 0,
            y: Number.isFinite(operation.node.position?.y) ? operation.node.position.y : 0,
          },
          schemaVersion: 1,
        },
      }];
    }
    if (operation.op === 'add_edge') {
      const sourceNodeId = resolveNode(operation.edge.sourceNodeId);
      const targetNodeId = resolveNode(operation.edge.targetNodeId);
      if (!nodeIds.has(sourceNodeId) || !nodeIds.has(targetNodeId)) return [];
      return [{
        op: 'add_edge',
        edge: {
          ...operation.edge,
          id: edgeIdByOperation.get(operation)!,
          sourceNodeId,
          targetNodeId,
        },
      }];
    }
    if (operation.op === 'remove_edge') {
      return [{ ...operation, edgeId: edgeReferences.get(operation.edgeId) ?? operation.edgeId }];
    }
    const nodeId = resolveNode(operation.nodeId);
    if (!nodeIds.has(nodeId)) return [];
    if (operation.op === 'move_node') {
      return [{
        ...operation,
        nodeId,
        position: {
          x: Number.isFinite(operation.position.x) ? operation.position.x : 0,
          y: Number.isFinite(operation.position.y) ? operation.position.y : 0,
        },
      }];
    }
    return [{ ...operation, nodeId }];
  });
}
