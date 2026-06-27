/**
 * 工作流序列（sequence）图算法（第 04 篇画布连线、第 05 篇生成编排）。
 *
 * 用户通过 `sequence` 类型的边把若干图片 / 视频节点自由连成「有向无环图」（上游输出即下游
 * 输入，参照 LibTV 等节点式工作流），作为「逐段首尾帧」视频合成的关键帧顺序。本模块是这些
 * 边的唯一图算法处：给定节点与边，解析出「经某成员节点的最长有向路径」作为关键帧顺序、判定
 * 成员归属、计算路径内序号。所有遍历均带在栈集环保护，即便实时回流引入异常拓扑也不会死循环。
 *
 * 约定：连接是「n:m」的——每个媒体节点可有多条出边与多条入边（{@link stores/canvas-store}
 * 的 `addSequenceEdge` 仅去重同向边、拒绝成环以保持有向无环）。图为线性时，「经节点的最长
 * 路径」即退化为整条链，与历史行为一致。本模块对多出 / 多入 / 自环 / 成环等退化拓扑仍做
 * 确定性降级，绝不抛错。
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

/** 解析得到的有序关键帧路径。 */
export interface SequenceChain {
  /** 经成员节点的最长有向路径成员（自上游至下游）。 */
  nodes: CanvasFlowNode[];
  /** 是否检测到环；为真时 `nodes` 为打断环后的安全结果。 */
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
 * 由序列边构建「出边 / 入边」多重邻接（n:m DAG：每节点可有多条出边与入边）。
 *
 * 同向重复边去重，保证一条逻辑连接只计一次；自环跳过。
 */
function buildAdjacency(edges: CanvasFlowEdge[]): {
  next: Map<string, string[]>;
  prev: Map<string, string[]>;
} {
  const next = new Map<string, string[]>();
  const prev = new Map<string, string[]>();
  for (const e of sequenceEdges(edges)) {
    if (e.source === e.target) continue; // 跳过自环
    const outs = next.get(e.source) ?? [];
    if (!outs.includes(e.target)) outs.push(e.target);
    next.set(e.source, outs);
    const ins = prev.get(e.target) ?? [];
    if (!ins.includes(e.source)) ins.push(e.source);
    prev.set(e.target, ins);
  }
  return { next, prev };
}

/** 节点空间比较（左→右、上→下、再按 id）：多分支等长时确定性择优，贴合视觉阅读序。 */
function compareSpatial(a: CanvasFlowNode | undefined, b: CanvasFlowNode | undefined): number {
  const ax = a?.position.x ?? Infinity;
  const bx = b?.position.x ?? Infinity;
  if (ax !== bx) return ax - bx;
  const ay = a?.position.y ?? Infinity;
  const by = b?.position.y ?? Infinity;
  if (ay !== by) return ay - by;
  return (a?.id ?? '').localeCompare(b?.id ?? '');
}

/**
 * 从 `start` 出发、沿 `adj` 方向的「最长有向路径」（节点 id 列表，不含 start 自身）。
 *
 * 多分支时取更长者；等长按邻居空间序（{@link compareSpatial}）确定性择一。带「在栈集」
 * （inStack）环保护：遇到回到当前递归栈上的节点即截断并标记 `onCycle`，退化拓扑（成环）下
 * 绝不死循环。DAG 下经 memo 记忆化，复杂度 O(V+E)。
 */
function longestPathFrom(
  start: string,
  adj: Map<string, string[]>,
  byId: Map<string, CanvasFlowNode>,
  memo: Map<string, string[]>,
  inStack: Set<string>,
  onCycle: () => void,
): string[] {
  const cached = memo.get(start);
  if (cached) return cached;

  inStack.add(start);
  const neighbors = [...(adj.get(start) ?? [])].sort((a, b) =>
    compareSpatial(byId.get(a), byId.get(b)),
  );
  let best: string[] = [];
  for (const n of neighbors) {
    if (inStack.has(n)) {
      onCycle();
      continue; // 截断环，保证终止
    }
    const sub = longestPathFrom(n, adj, byId, memo, inStack, onCycle);
    if (sub.length + 1 > best.length) best = [n, ...sub];
  }
  inStack.delete(start);
  memo.set(start, best);
  return best;
}

/**
 * 解析「经某成员节点的最长有向序列路径」。
 *
 * n:m DAG 下成员可有多条出 / 入边，已无唯一「链」可言；本函数取经该节点的最长有向路径作为
 * 关键帧顺序——上游最长入路径（反向，自远而近）+ 自身 + 下游最长出路径。图为线性时即退化
 * 为整条链，与历史行为一致。仅返回仍存在且可参与序列的节点；成员本身不可参与或不在任何序列
 * 边上时，返回单元素（或空）结果。所有遍历带在栈环保护，成环时做确定性降级，绝不抛错。
 *
 * @param nodes - 当前全部节点
 * @param edges - 当前全部边
 * @param memberId - 路径中任一成员节点 id
 * @returns 有序成员（自上游至下游）与环标记
 */
export function resolveSequenceChain(
  nodes: CanvasFlowNode[],
  edges: CanvasFlowEdge[],
  memberId: string,
): SequenceChain {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const { next, prev } = buildAdjacency(edges);

  let hasCycle = false;
  const onCycle = () => {
    hasCycle = true;
  };

  // 上游：沿入边的最长路径（自近及远），反转得「自远而近」；下游：沿出边的最长路径
  const upstream = longestPathFrom(memberId, prev, byId, new Map(), new Set(), onCycle);
  const downstream = longestPathFrom(memberId, next, byId, new Map(), new Set(), onCycle);
  const orderedIds = [...[...upstream].reverse(), memberId, ...downstream];

  const ordered: CanvasFlowNode[] = [];
  const seen = new Set<string>();
  for (const id of orderedIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const node = byId.get(id);
    if (node && isSequenceable(node)) ordered.push(node);
  }
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
  // target 已能经现有出边（沿任一分支）到达 source 时，新增 source → target 即成环
  const seen = new Set<string>([target]);
  const stack: string[] = [target];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur === undefined) break;
    if (cur === source) return true;
    for (const nb of next.get(cur) ?? []) {
      if (!seen.has(nb)) {
        seen.add(nb);
        stack.push(nb);
      }
    }
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
