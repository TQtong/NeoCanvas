/**
 * 工作流序列（sequence）图算法（第 04 篇画布连线、第 05 篇生成编排）。
 *
 * 用户通过 `sequence` 类型的边把若干图片 / 视频节点连成「有向链」，作为「逐段首尾帧」
 * 视频合成的关键帧顺序。本模块是这些边的唯一图算法处：给定节点与边，解析出某成员节点
 * 所在的完整有序链、判定成员归属、计算链内序号。所有遍历均带访问集（visited）环保护，
 * 即便实时回流引入异常拓扑也不会死循环。
 *
 * 约定：链是「线性」的——每个节点至多一条出边、至多一条入边（由
 * {@link stores/canvas-store} 的 `addSequenceEdge` 在连接时强制）。即便如此，本模块对
 * 多出 / 多入 / 自环 / 成环等退化拓扑仍做确定性降级，绝不抛错。
 *
 * @module lib/canvas/sequence
 */

import { MarkerType, type EdgeMarker } from '@xyflow/react';
import type { CanvasFlowEdge, CanvasFlowNode } from './node-mapper';

/** 工作流序列边的类型标识，与 {@link types/edges}.EDGE_TYPES 一致。 */
export const SEQUENCE_EDGE_TYPE = 'sequence' as const;

/**
 * 序列连接桩的 handle id（写入 `canvas_edges.source_handle / target_handle`）。
 * 单一来源在此声明，由节点桩组件与状态库的建边逻辑共同引用，确保创建与加载两路一致。
 */
export const SEQUENCE_HANDLE_IN = 'seq-in';
export const SEQUENCE_HANDLE_OUT = 'seq-out';

/**
 * 序列边末端箭头（指向「下一帧」，强调色）。color 取主题强调色令牌 `hsl(var(--accent))`，
 * 与边本体 `stroke-accent`、拖拽预览线同源，亮 / 暗主题随动一致。
 */
export const SEQUENCE_MARKER_END: EdgeMarker = {
  type: MarkerType.ArrowClosed,
  width: 16,
  height: 16,
  color: 'hsl(var(--accent))',
};

/**
 * 为序列边附加渲染装饰：类型、流动动画与末端箭头。装饰字段不参与持久化
 * （见 {@link lib/canvas/node-mapper}.edgeToInsert），由创建与加载两处统一施加，保证一致外观。
 *
 * @param edge - 基础边（至少含 id / source / target）
 * @returns 带装饰的序列边
 */
export function decorateSequenceEdge(edge: CanvasFlowEdge): CanvasFlowEdge {
  return {
    ...edge,
    type: SEQUENCE_EDGE_TYPE,
    animated: true,
    markerEnd: SEQUENCE_MARKER_END,
  };
}

/** 可参与序列链的节点类型（仅承载媒体的图片 / 视频）。 */
const SEQUENCEABLE_TYPES = new Set(['image', 'video']);

/** 解析得到的有序链。 */
export interface SequenceChain {
  /** 按方向排列的成员节点（自链头至链尾）。 */
  nodes: CanvasFlowNode[];
  /** 是否检测到环（链头回指自身）；为真时 `nodes` 为打断环后的安全前缀。 */
  hasCycle: boolean;
}

/** 节点是否可作为序列链成员。 */
export function isSequenceable(node: CanvasFlowNode): boolean {
  return SEQUENCEABLE_TYPES.has(node.data.type);
}

/** 仅取 `sequence` 类型的边。 */
function sequenceEdges(edges: CanvasFlowEdge[]): CanvasFlowEdge[] {
  return edges.filter((e) => e.type === SEQUENCE_EDGE_TYPE);
}

/**
 * 由序列边构建「出边 / 入边」邻接（线性链下各为一对一）。
 *
 * 退化拓扑（同一源多出边）下，后写入者覆盖前者，保证确定性。
 */
function buildAdjacency(edges: CanvasFlowEdge[]): {
  next: Map<string, string>;
  prev: Map<string, string>;
} {
  const next = new Map<string, string>();
  const prev = new Map<string, string>();
  for (const e of sequenceEdges(edges)) {
    if (e.source === e.target) continue; // 跳过自环
    next.set(e.source, e.target);
    prev.set(e.target, e.source);
  }
  return { next, prev };
}

/**
 * 解析某成员节点所在的完整有序链。
 *
 * 步骤：自该节点沿入边回溯至链头（带 visited 环保护），再沿出边正向收集至链尾。
 * 仅返回仍存在且可参与序列的节点；若成员节点本身不可参与或不在任何序列边上，返回单元素链。
 *
 * @param nodes - 当前全部节点
 * @param edges - 当前全部边
 * @param memberId - 链中任一成员节点 id
 * @returns 有序链与环标记
 */
export function resolveSequenceChain(
  nodes: CanvasFlowNode[],
  edges: CanvasFlowEdge[],
  memberId: string,
): SequenceChain {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const { next, prev } = buildAdjacency(edges);

  // 回溯链头
  let head = memberId;
  const seenBack = new Set<string>([head]);
  let hasCycle = false;
  for (;;) {
    const p = prev.get(head);
    if (p === undefined) break;
    if (seenBack.has(p)) {
      hasCycle = true;
      break;
    }
    seenBack.add(p);
    head = p;
  }

  // 自链头正向收集
  const ordered: CanvasFlowNode[] = [];
  const seenFwd = new Set<string>();
  let cur: string | undefined = head;
  while (cur !== undefined && !seenFwd.has(cur)) {
    seenFwd.add(cur);
    const node = byId.get(cur);
    if (node && isSequenceable(node)) ordered.push(node);
    cur = next.get(cur);
  }
  if (cur !== undefined && seenFwd.has(cur)) hasCycle = true;

  return { nodes: ordered, hasCycle };
}

/**
 * 预判：在现有序列边上新增 `source → target` 是否会形成环
 * （即 `target` 当前已可经序列出边到达 `source`）。连接时据此拒绝成环。
 *
 * @param edges - 当前全部边
 * @param source - 拟新增边的源
 * @param target - 拟新增边的目标
 * @returns 是否会成环
 */
export function wouldCreateSequenceCycle(
  edges: CanvasFlowEdge[],
  source: string,
  target: string,
): boolean {
  if (source === target) return true;
  const { next } = buildAdjacency(edges);
  const seen = new Set<string>();
  let cur: string | undefined = target;
  while (cur !== undefined && !seen.has(cur)) {
    if (cur === source) return true;
    seen.add(cur);
    cur = next.get(cur);
  }
  return false;
}

/**
 * 判定节点是否为任一序列边的端点（成员）。
 *
 * @param edges - 当前全部边
 * @param nodeId - 节点 id
 * @returns 是否为序列链成员
 */
export function isSequenceMember(edges: CanvasFlowEdge[], nodeId: string): boolean {
  return sequenceEdges(edges).some((e) => e.source === nodeId || e.target === nodeId);
}

/**
 * 节点在其所在链中的 0 基序号；非成员或不可参与时返回 -1。
 *
 * 供序列边渲染段号徽标使用。
 *
 * @param nodes - 当前全部节点
 * @param edges - 当前全部边
 * @param nodeId - 节点 id
 * @returns 链内 0 基序号，或 -1
 */
export function sequenceOrderIndex(
  nodes: CanvasFlowNode[],
  edges: CanvasFlowEdge[],
  nodeId: string,
): number {
  if (!isSequenceMember(edges, nodeId)) return -1;
  const chain = resolveSequenceChain(nodes, edges, nodeId);
  return chain.nodes.findIndex((n) => n.id === nodeId);
}
