/**
 * 数据库行 ↔ React Flow 对象 的双向映射器（第 06 篇第七节）。
 *
 * 这是 `canvas_nodes` / `canvas_edges` 行数据与画布对象之间唯一的转换处，避免坐标系
 * 与字段错配散落各处。通用几何与层级在列、类型私有内容在 data；`rotation` /
 * `asset_id` / `generation_id` 三个桥接字段在映射时并入 / 析出节点 data。
 *
 * @module lib/canvas/node-mapper
 */

import type { Edge, Node } from '@xyflow/react';
import type {
  CanvasEdgeRow,
  CanvasNodeRow,
  Database,
  EdgeData,
  GenerationPlaceholderNodeData,
  ImageNodeData,
  NodeData,
  VideoNodeData,
} from '@/types';
import { createDefaultNodeDataUnion, DEFAULT_NODE_SIZE } from './constants';
import { decorateSequenceEdge, SEQUENCE_EDGE_TYPE } from './sequence';
import { ANNOTATION_EDGE_TYPE, decorateAnnotationEdge } from './annotation';
import { decorateMediaCandidateEdge, MEDIA_CANDIDATE_EDGE_TYPE } from './media-candidate';

/** 本项目的 React Flow 节点类型别名。 */
export type CanvasFlowNode = Node<NodeData>;

/** 本项目的 React Flow 边类型别名。 */
export type CanvasFlowEdge = Edge<EdgeData>;

/** canvas_nodes 插入载荷类型。 */
type CanvasNodeInsert = Database['public']['Tables']['canvas_nodes']['Insert'];
/** canvas_nodes 更新载荷类型。 */
type CanvasNodeUpdate = Database['public']['Tables']['canvas_nodes']['Update'];
/** canvas_edges 插入载荷类型。 */
type CanvasEdgeInsert = Database['public']['Tables']['canvas_edges']['Insert'];

/** data 中不持久化的运行时字段（由映射器在加载时注入）。 */
const RUNTIME_FIELDS = new Set([
  'src',
  'thumbnailSrc',
  'posterSrc',
  'progress',
  'statusLabel',
  'errorMessage',
  'urlExpiresAt',
]);

/** data 中由独立列承载、不应写入 data JSONB 的桥接字段。 */
const BRIDGE_FIELDS = new Set(['type', 'rotation', 'assetId', 'generationId']);

/**
 * 由行还原节点 data：以默认 data 兜底，叠加列中的类型私有内容，并并入桥接字段。
 *
 * @param row - canvas_nodes 行
 * @returns 还原后的节点 data
 */
export function rowToNodeData(row: CanvasNodeRow): NodeData {
  const base = createDefaultNodeDataUnion(row.type);
  const merged = {
    ...(base as Record<string, unknown>),
    ...row.data,
    // 桥接字段以列为准
    type: row.type,
    rotation: row.rotation,
  } as NodeData;

  // 资产 / 生成引用以列为准
  if (merged.type === 'image' || merged.type === 'video') {
    (merged as ImageNodeData | VideoNodeData).assetId = row.asset_id;
  }
  if (merged.type === 'generation_placeholder') {
    (merged as GenerationPlaceholderNodeData).generationId = row.generation_id;
  }

  return merged;
}

/**
 * 行 → React Flow 节点。
 *
 * @param row - canvas_nodes 行
 * @returns React Flow 节点
 */
export function rowToNode(row: CanvasNodeRow): CanvasFlowNode {
  const data = rowToNodeData(row);
  const fallback = DEFAULT_NODE_SIZE[row.type];
  const width = row.width ?? fallback.width;
  const height = row.height ?? fallback.height;

  const node: CanvasFlowNode = {
    id: row.id,
    type: row.type,
    position: { x: row.position_x, y: row.position_y },
    data,
    width,
    height,
    // React Flow 的 pane 位于 z=0；负层级节点虽然可见，但节点工具栏会落到 pane 后方而无法点击。
    zIndex: Math.max(0, row.z_index),
    style: { width, height },
  };

  if (row.parent_id) {
    node.parentId = row.parent_id;
    node.extent = 'parent';
  }

  return node;
}

/**
 * 从节点 data 析出可持久化的类型私有内容（剔除桥接与运行时字段）。
 *
 * @param data - 节点 data
 * @returns 写入 `canvas_nodes.data` 的对象
 */
export function nodeDataToColumn(data: NodeData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (BRIDGE_FIELDS.has(key) || RUNTIME_FIELDS.has(key)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * 从节点 data 析出资产 / 生成引用列值。
 *
 * @param data - 节点 data
 * @returns asset_id 与 generation_id
 */
function extractRefs(data: NodeData): { assetId: string | null; generationId: string | null } {
  let assetId: string | null = null;
  let generationId: string | null = null;
  if (data.type === 'image' || data.type === 'video') {
    assetId = data.assetId;
  }
  if (data.type === 'generation_placeholder') {
    generationId = data.generationId;
  }
  return { assetId, generationId };
}

/**
 * 节点 → 可更新列集合（按节点粒度全列写回，与「最后写入胜出」一致）。
 *
 * @param node - React Flow 节点
 * @returns canvas_nodes 可更新列
 */
export function nodeToColumns(node: CanvasFlowNode): CanvasNodeUpdate {
  const { assetId, generationId } = extractRefs(node.data);
  const width = typeof node.width === 'number' ? node.width : null;
  const height = typeof node.height === 'number' ? node.height : null;
  return {
    type: node.data.type,
    position_x: node.position.x,
    position_y: node.position.y,
    width,
    height,
    rotation: node.data.rotation ?? 0,
    z_index: Math.max(0, node.zIndex ?? 0),
    parent_id: node.parentId ?? null,
    data: nodeDataToColumn(node.data),
    asset_id: assetId,
    generation_id: generationId,
  };
}

/**
 * 节点 → 插入载荷。
 *
 * @param node - React Flow 节点
 * @param projectId - 所属项目
 * @param createdBy - 创建者用户标识
 * @returns canvas_nodes 插入载荷
 */
export function nodeToInsert(
  node: CanvasFlowNode,
  projectId: string,
  createdBy: string,
): CanvasNodeInsert {
  const columns = nodeToColumns(node);
  return {
    id: node.id,
    project_id: projectId,
    type: node.data.type,
    position_x: node.position.x,
    position_y: node.position.y,
    width: columns.width ?? null,
    height: columns.height ?? null,
    rotation: node.data.rotation ?? 0,
    z_index: columns.z_index ?? 0,
    parent_id: node.parentId ?? null,
    data: columns.data ?? {},
    asset_id: columns.asset_id ?? null,
    generation_id: columns.generation_id ?? null,
    created_by: createdBy,
  };
}

/**
 * 行 → React Flow 边。
 *
 * @param row - canvas_edges 行
 * @returns React Flow 边
 */
export function rowToEdge(row: CanvasEdgeRow): CanvasFlowEdge {
  const edge: CanvasFlowEdge = {
    id: row.id,
    source: row.source_node_id,
    target: row.target_node_id,
    data: row.data,
  };
  if (row.source_handle) edge.sourceHandle = row.source_handle;
  if (row.target_handle) edge.targetHandle = row.target_handle;
  if (row.type && row.type !== 'default') edge.type = row.type;
  // 序列 / 描述边：加载时统一施加渲染装饰（动画 / 虚线 + 末端箭头），与创建路径外观一致
  if (edge.type === SEQUENCE_EDGE_TYPE) return decorateSequenceEdge(edge);
  if (edge.type === ANNOTATION_EDGE_TYPE) return decorateAnnotationEdge(edge);
  if (edge.type === MEDIA_CANDIDATE_EDGE_TYPE) return decorateMediaCandidateEdge(edge);
  return edge;
}

/**
 * 边 → 插入载荷。
 *
 * @param edge - React Flow 边
 * @param projectId - 所属项目
 * @returns canvas_edges 插入载荷
 */
export function edgeToInsert(edge: CanvasFlowEdge, projectId: string): CanvasEdgeInsert {
  return {
    id: edge.id,
    project_id: projectId,
    source_node_id: edge.source,
    target_node_id: edge.target,
    source_handle: edge.sourceHandle ?? null,
    target_handle: edge.targetHandle ?? null,
    type: edge.type ?? 'default',
    data: (edge.data ?? {}) as EdgeData,
  };
}

/**
 * 取节点的轴对齐框（flow 坐标），供包围盒 / 对齐 / 组变换使用。
 *
 * @param node - React Flow 节点
 * @returns 节点框
 */
export function nodeBox(node: CanvasFlowNode): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const fallback = DEFAULT_NODE_SIZE[node.data.type];
  return {
    x: node.position.x,
    y: node.position.y,
    width: typeof node.width === 'number' ? node.width : fallback.width,
    height: typeof node.height === 'number' ? node.height : fallback.height,
  };
}
