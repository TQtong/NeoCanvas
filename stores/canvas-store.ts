'use client';

/**
 * 画布状态库（第 04 篇第三节）。
 *
 * 持有节点、边、视口、选择集、当前工具与交互瞬态，是画布交互在客户端的单一事实来源。
 * 与后端的协调遵循「乐观更新 + 防抖持久化 + 实时回流校正」三段式：本地动作即时更新
 * 并记录脏集，由持久化控制器防抖写回；远端经 Realtime 推来的变更按服务端版本
 * （updated_at）与本地比较，较新者覆盖，并以版本对照实现回声抑制。
 *
 * @module stores/canvas-store
 */

import { applyEdgeChanges, applyNodeChanges, type EdgeChange, type NodeChange } from '@xyflow/react';
import { create } from 'zustand';
import type {
  CanvasBackgroundSettings,
  CanvasEdgeRow,
  CanvasNodeRow,
  GenerationRow,
  NodeData,
  RealtimeChange,
  Viewport,
} from '@/types';
import type { AlignmentGuide } from '@/lib/canvas/alignment';
import {
  type CanvasFlowEdge,
  type CanvasFlowNode,
  rowToEdge,
  rowToNode,
} from '@/lib/canvas/node-mapper';
import { DEFAULT_VIEWPORT, PASTE_OFFSET } from '@/lib/canvas/constants';
import { uuid } from '@/lib/utils/id';

/** 画布工具，对应底部工具栏的十个工具（第 01 篇、第 04 篇 4.9）。 */
export type CanvasTool =
  | 'select'
  | 'pan'
  | 'upload-image'
  | 'frame'
  | 'shape'
  | 'draw'
  | 'text'
  | 'ai-image'
  | 'ai-video'
  | 'ai-text';

/** 框选瞬态（屏幕坐标）。 */
export interface MarqueeState {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
}

/** 持久化脏集快照（供持久化控制器消费）。 */
export interface DirtyFlush {
  /** 需 upsert 的节点。 */
  upserts: CanvasFlowNode[];
  /** 需删除的节点 id。 */
  deletes: string[];
  /** 需 upsert 的边。 */
  edgeUpserts: CanvasFlowEdge[];
  /** 需删除的边 id。 */
  edgeDeletes: string[];
}

/** 画布状态库的状态与动作。 */
export interface CanvasState {
  /** 所属项目。 */
  projectId: string | null;
  /** 节点集合（按 z_index 渲染）。 */
  nodes: CanvasFlowNode[];
  /** 边集合。 */
  edges: CanvasFlowEdge[];
  /** 当前视口。 */
  viewport: Viewport;
  /** 选择集（节点 id）。 */
  selectedNodeIds: string[];
  /** 当前激活工具。 */
  activeTool: CanvasTool;
  /** 正在就地编辑文本的节点 id。 */
  editingNodeId: string | null;
  /** 框选瞬态。 */
  marquee: MarqueeState | null;
  /** 对齐参考线（拖动中）。 */
  guides: AlignmentGuide[];
  /** 背景网格设置。 */
  background: CanvasBackgroundSettings;
  /** 左下图层列表是否展开。 */
  layersOpen: boolean;
  /** 剪贴板（复制的节点快照）。 */
  clipboard: CanvasFlowNode[];
  /** 是否处于连续创建模式（创建后不回落选择工具）。 */
  continuousCreate: boolean;

  // ----- 内部：持久化脏集与版本对照（回声抑制） -----
  /** 脏节点 id。 */
  _dirtyNodeIds: Set<string>;
  /** 待删除节点 id。 */
  _deletedNodeIds: Set<string>;
  /** 脏边 id。 */
  _dirtyEdgeIds: Set<string>;
  /** 待删除边 id。 */
  _deletedEdgeIds: Set<string>;
  /** 节点服务端版本（updated_at），用于回声抑制与最后写入胜出。 */
  _nodeVersions: Record<string, string>;
  /** 视口是否脏。 */
  _viewportDirty: boolean;

  // ----- 初始化 -----
  /** 以服务端快照初始化（水合）。 */
  hydrate: (params: {
    projectId: string;
    nodeRows: CanvasNodeRow[];
    edgeRows: CanvasEdgeRow[];
    viewport: Viewport;
  }) => void;
  /** 离开项目时重置。 */
  reset: () => void;

  // ----- React Flow 变更入口 -----
  /** 处理 React Flow 节点变更（位置 / 尺寸 / 选择 / 删除）。 */
  handleNodesChange: (changes: NodeChange<CanvasFlowNode>[]) => void;
  /** 处理 React Flow 边变更。 */
  handleEdgesChange: (changes: EdgeChange<CanvasFlowEdge>[]) => void;

  // ----- 节点动作 -----
  /** 添加一个节点。 */
  addNode: (node: CanvasFlowNode, options?: { select?: boolean }) => void;
  /** 批量添加节点。 */
  addNodes: (nodes: CanvasFlowNode[], options?: { select?: boolean }) => void;
  /** 更新节点（合并顶层字段）。 */
  updateNode: (id: string, patch: Partial<CanvasFlowNode>) => void;
  /** 更新节点 data（合并），标记脏集以持久化。 */
  updateNodeData: (id: string, dataPatch: Partial<NodeData>) => void;
  /** 仅更新运行时 data 字段（如签名 URL、进度），不标记脏集、不触发持久化。 */
  setNodeRuntime: (id: string, dataPatch: Partial<NodeData>) => void;
  /** 删除节点（连带其作为父的子节点解除父子并删自身）。 */
  removeNodes: (ids: string[]) => void;
  /** 替换某节点（用于占位转化等整节点替换）。 */
  replaceNode: (id: string, node: CanvasFlowNode) => void;

  // ----- 选择 -----
  setSelection: (ids: string[]) => void;
  addToSelection: (id: string) => void;
  toggleSelection: (id: string) => void;
  clearSelection: () => void;
  selectAll: () => void;

  // ----- 工具与视口 -----
  setTool: (tool: CanvasTool) => void;
  setEditingNode: (id: string | null) => void;
  setViewport: (viewport: Viewport, options?: { persist?: boolean }) => void;
  setBackground: (background: Partial<CanvasBackgroundSettings>) => void;
  toggleLayers: () => void;
  setContinuousCreate: (value: boolean) => void;

  // ----- 层级 -----
  bringToFront: (ids: string[]) => void;
  sendToBack: (ids: string[]) => void;
  moveForward: (ids: string[]) => void;
  moveBackward: (ids: string[]) => void;
  reorderNode: (id: string, targetZIndex: number) => void;

  // ----- 剪贴板 -----
  copySelection: () => void;
  paste: () => void;
  duplicateSelection: () => void;

  // ----- 交互瞬态 -----
  setMarquee: (marquee: MarqueeState | null) => void;
  setGuides: (guides: AlignmentGuide[]) => void;

  // ----- 边 -----
  addEdge: (edge: CanvasFlowEdge) => void;
  removeEdges: (ids: string[]) => void;

  // ----- 远端回流 -----
  applyRemoteNode: (change: RealtimeChange<CanvasNodeRow>) => void;
  applyRemoteEdge: (change: RealtimeChange<CanvasEdgeRow>) => void;
  applyRemoteGeneration: (change: RealtimeChange<GenerationRow>) => void;

  // ----- 持久化协调 -----
  /** 以快照整体替换节点 / 边（用于撤销 / 重做），并据差异标记脏 / 删除集以持久化。 */
  restoreGraph: (nodes: CanvasFlowNode[], edges: CanvasFlowEdge[]) => void;
  /** 标记某节点已持久化（记录服务端版本，用于回声抑制）。 */
  markNodePersisted: (id: string, updatedAt: string) => void;
  /** 取出并清空脏集快照，供持久化控制器写回。 */
  flushDirty: () => DirtyFlush;
  /** 取出并清空视口脏标记。 */
  flushViewportDirty: () => boolean;
}

/** 默认背景：点状网格。 */
const DEFAULT_BACKGROUND: CanvasBackgroundSettings = { variant: 'dots', gap: 24 };

/** 取节点集合中的最大 / 最小 z_index。 */
function zRange(nodes: CanvasFlowNode[]): { min: number; max: number } {
  if (nodes.length === 0) return { min: 0, max: 0 };
  let min = Infinity;
  let max = -Infinity;
  for (const n of nodes) {
    const z = n.zIndex ?? 0;
    if (z < min) min = z;
    if (z > max) max = z;
  }
  return { min, max };
}

/** 比较两个 ISO 时间，a 是否不旧于 b。 */
function notOlderThan(a: string | undefined, b: string | undefined): boolean {
  if (!a) return false;
  if (!b) return true;
  return new Date(a).getTime() >= new Date(b).getTime();
}

export const useCanvasStore = create<CanvasState>((set, get) => ({
  projectId: null,
  nodes: [],
  edges: [],
  viewport: DEFAULT_VIEWPORT,
  selectedNodeIds: [],
  activeTool: 'select',
  editingNodeId: null,
  marquee: null,
  guides: [],
  background: DEFAULT_BACKGROUND,
  layersOpen: false,
  clipboard: [],
  continuousCreate: false,

  _dirtyNodeIds: new Set(),
  _deletedNodeIds: new Set(),
  _dirtyEdgeIds: new Set(),
  _deletedEdgeIds: new Set(),
  _nodeVersions: {},
  _viewportDirty: false,

  hydrate: ({ projectId, nodeRows, edgeRows, viewport }) => {
    const versions: Record<string, string> = {};
    for (const row of nodeRows) versions[row.id] = row.updated_at;
    set({
      projectId,
      nodes: nodeRows.map(rowToNode).sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0)),
      edges: edgeRows.map(rowToEdge),
      viewport,
      selectedNodeIds: [],
      editingNodeId: null,
      guides: [],
      marquee: null,
      _dirtyNodeIds: new Set(),
      _deletedNodeIds: new Set(),
      _dirtyEdgeIds: new Set(),
      _deletedEdgeIds: new Set(),
      _nodeVersions: versions,
      _viewportDirty: false,
    });
  },

  reset: () => {
    set({
      projectId: null,
      nodes: [],
      edges: [],
      viewport: DEFAULT_VIEWPORT,
      selectedNodeIds: [],
      activeTool: 'select',
      editingNodeId: null,
      marquee: null,
      guides: [],
      clipboard: [],
      _dirtyNodeIds: new Set(),
      _deletedNodeIds: new Set(),
      _dirtyEdgeIds: new Set(),
      _deletedEdgeIds: new Set(),
      _nodeVersions: {},
      _viewportDirty: false,
    });
  },

  handleNodesChange: (changes) => {
    const dirty = new Set(get()._dirtyNodeIds);
    const deleted = new Set(get()._deletedNodeIds);
    const selected = new Set(get().selectedNodeIds);

    for (const change of changes) {
      if (change.type === 'position' && change.dragging !== undefined) {
        dirty.add(change.id);
      } else if (change.type === 'dimensions' && change.resizing) {
        dirty.add(change.id);
      } else if (change.type === 'remove') {
        deleted.add(change.id);
        dirty.delete(change.id);
        selected.delete(change.id);
      } else if (change.type === 'select') {
        if (change.selected) selected.add(change.id);
        else selected.delete(change.id);
      }
    }

    set({
      nodes: applyNodeChanges(changes, get().nodes),
      selectedNodeIds: Array.from(selected),
      _dirtyNodeIds: dirty,
      _deletedNodeIds: deleted,
    });
  },

  handleEdgesChange: (changes) => {
    const dirty = new Set(get()._dirtyEdgeIds);
    const deleted = new Set(get()._deletedEdgeIds);
    for (const change of changes) {
      if (change.type === 'remove') {
        deleted.add(change.id);
        dirty.delete(change.id);
      }
    }
    set({
      edges: applyEdgeChanges(changes, get().edges),
      _dirtyEdgeIds: dirty,
      _deletedEdgeIds: deleted,
    });
  },

  addNode: (node, options) => {
    get().addNodes([node], options);
  },

  addNodes: (newNodes, options) => {
    const dirty = new Set(get()._dirtyNodeIds);
    for (const n of newNodes) dirty.add(n.id);
    const select = options?.select ?? true;
    set((state) => ({
      nodes: [...state.nodes, ...newNodes],
      selectedNodeIds: select ? newNodes.map((n) => n.id) : state.selectedNodeIds,
      _dirtyNodeIds: dirty,
    }));
  },

  updateNode: (id, patch) => {
    const dirty = new Set(get()._dirtyNodeIds);
    dirty.add(id);
    set((state) => ({
      nodes: state.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)),
      _dirtyNodeIds: dirty,
    }));
  },

  updateNodeData: (id, dataPatch) => {
    const dirty = new Set(get()._dirtyNodeIds);
    dirty.add(id);
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === id ? { ...n, data: { ...n.data, ...dataPatch } as NodeData } : n,
      ),
      _dirtyNodeIds: dirty,
    }));
  },

  setNodeRuntime: (id, dataPatch) => {
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === id ? { ...n, data: { ...n.data, ...dataPatch } as NodeData } : n,
      ),
    }));
  },

  removeNodes: (ids) => {
    const idSet = new Set(ids);
    const deleted = new Set(get()._deletedNodeIds);
    const dirty = new Set(get()._dirtyNodeIds);
    for (const id of ids) {
      deleted.add(id);
      dirty.delete(id);
    }
    set((state) => ({
      // 删除目标节点，并解除以其为父的子节点的父子关系
      nodes: state.nodes
        .filter((n) => !idSet.has(n.id))
        .map((n) => (n.parentId && idSet.has(n.parentId) ? { ...n, parentId: undefined, extent: undefined } : n)),
      selectedNodeIds: state.selectedNodeIds.filter((sid) => !idSet.has(sid)),
      _deletedNodeIds: deleted,
      _dirtyNodeIds: dirty,
    }));
  },

  replaceNode: (id, node) => {
    const dirty = new Set(get()._dirtyNodeIds);
    dirty.add(node.id);
    set((state) => ({
      nodes: state.nodes.map((n) => (n.id === id ? node : n)),
      _dirtyNodeIds: dirty,
    }));
  },

  setSelection: (ids) => set({ selectedNodeIds: ids }),
  addToSelection: (id) =>
    set((state) => ({
      selectedNodeIds: state.selectedNodeIds.includes(id)
        ? state.selectedNodeIds
        : [...state.selectedNodeIds, id],
    })),
  toggleSelection: (id) =>
    set((state) => ({
      selectedNodeIds: state.selectedNodeIds.includes(id)
        ? state.selectedNodeIds.filter((sid) => sid !== id)
        : [...state.selectedNodeIds, id],
    })),
  clearSelection: () => set({ selectedNodeIds: [] }),
  selectAll: () => set((state) => ({ selectedNodeIds: state.nodes.map((n) => n.id) })),

  setTool: (tool) => set({ activeTool: tool, editingNodeId: tool === 'text' ? get().editingNodeId : null }),
  setEditingNode: (id) => set({ editingNodeId: id }),

  setViewport: (viewport, options) =>
    set({ viewport, _viewportDirty: options?.persist ?? get()._viewportDirty }),

  setBackground: (background) =>
    set((state) => ({ background: { ...state.background, ...background } })),

  toggleLayers: () => set((state) => ({ layersOpen: !state.layersOpen })),
  setContinuousCreate: (value) => set({ continuousCreate: value }),

  bringToFront: (ids) => {
    const { max } = zRange(get().nodes);
    const idSet = new Set(ids);
    const dirty = new Set(get()._dirtyNodeIds);
    let next = max + 1;
    set((state) => ({
      nodes: state.nodes.map((n) => {
        if (idSet.has(n.id)) {
          dirty.add(n.id);
          return { ...n, zIndex: next++ };
        }
        return n;
      }),
      _dirtyNodeIds: dirty,
    }));
  },

  sendToBack: (ids) => {
    const { min } = zRange(get().nodes);
    const idSet = new Set(ids);
    const dirty = new Set(get()._dirtyNodeIds);
    let next = min - ids.length;
    set((state) => ({
      nodes: state.nodes.map((n) => {
        if (idSet.has(n.id)) {
          dirty.add(n.id);
          return { ...n, zIndex: next++ };
        }
        return n;
      }),
      _dirtyNodeIds: dirty,
    }));
  },

  moveForward: (ids) => {
    const idSet = new Set(ids);
    const dirty = new Set(get()._dirtyNodeIds);
    set((state) => ({
      nodes: state.nodes.map((n) => {
        if (idSet.has(n.id)) {
          dirty.add(n.id);
          return { ...n, zIndex: (n.zIndex ?? 0) + 1 };
        }
        return n;
      }),
      _dirtyNodeIds: dirty,
    }));
  },

  moveBackward: (ids) => {
    const idSet = new Set(ids);
    const dirty = new Set(get()._dirtyNodeIds);
    set((state) => ({
      nodes: state.nodes.map((n) => {
        if (idSet.has(n.id)) {
          dirty.add(n.id);
          return { ...n, zIndex: (n.zIndex ?? 0) - 1 };
        }
        return n;
      }),
      _dirtyNodeIds: dirty,
    }));
  },

  reorderNode: (id, targetZIndex) => {
    const dirty = new Set(get()._dirtyNodeIds);
    dirty.add(id);
    set((state) => ({
      nodes: state.nodes.map((n) => (n.id === id ? { ...n, zIndex: targetZIndex } : n)),
      _dirtyNodeIds: dirty,
    }));
  },

  copySelection: () => {
    const { nodes, selectedNodeIds } = get();
    const sel = new Set(selectedNodeIds);
    set({ clipboard: nodes.filter((n) => sel.has(n.id)).map((n) => ({ ...n, data: { ...n.data } })) });
  },

  paste: () => {
    const { clipboard } = get();
    if (clipboard.length === 0) return;
    const { max } = zRange(get().nodes);
    const pasted: CanvasFlowNode[] = clipboard.map((n, index) => ({
      ...n,
      id: uuid(),
      position: { x: n.position.x + PASTE_OFFSET, y: n.position.y + PASTE_OFFSET },
      zIndex: max + 1 + index,
      selected: true,
      data: { ...n.data },
    }));
    get().addNodes(pasted, { select: true });
  },

  duplicateSelection: () => {
    get().copySelection();
    get().paste();
  },

  setMarquee: (marquee) => set({ marquee }),
  setGuides: (guides) => set({ guides }),

  addEdge: (edge) => {
    const dirty = new Set(get()._dirtyEdgeIds);
    dirty.add(edge.id);
    set((state) => ({ edges: [...state.edges, edge], _dirtyEdgeIds: dirty }));
  },

  removeEdges: (ids) => {
    const idSet = new Set(ids);
    const deleted = new Set(get()._deletedEdgeIds);
    for (const id of ids) deleted.add(id);
    set((state) => ({
      edges: state.edges.filter((e) => !idSet.has(e.id)),
      _deletedEdgeIds: deleted,
    }));
  },

  applyRemoteNode: (change) => {
    const { eventType } = change;
    if (eventType === 'DELETE') {
      const id = (change.old as Partial<CanvasNodeRow>).id;
      if (!id) return;
      set((state) => ({
        nodes: state.nodes.filter((n) => n.id !== id),
        selectedNodeIds: state.selectedNodeIds.filter((sid) => sid !== id),
      }));
      return;
    }

    const row = change.new as CanvasNodeRow;
    if (!row?.id) return;

    // 回声抑制 + 最后写入胜出：远端版本不新于本地已知版本则忽略
    const localVersion = get()._nodeVersions[row.id];
    if (notOlderThan(localVersion, row.updated_at)) return;

    const node = rowToNode(row);
    set((state) => {
      const exists = state.nodes.some((n) => n.id === row.id);
      // 保留本地选择 / 编辑等瞬态
      const merged = exists
        ? state.nodes.map((n) => (n.id === row.id ? { ...n, ...node, selected: n.selected } : n))
        : [...state.nodes, node];
      return {
        nodes: merged,
        _nodeVersions: { ...state._nodeVersions, [row.id]: row.updated_at },
      };
    });
  },

  applyRemoteEdge: (change) => {
    if (change.eventType === 'DELETE') {
      const id = (change.old as Partial<CanvasEdgeRow>).id;
      if (!id) return;
      set((state) => ({ edges: state.edges.filter((e) => e.id !== id) }));
      return;
    }
    const row = change.new as CanvasEdgeRow;
    if (!row?.id) return;
    const edge = rowToEdge(row);
    set((state) => {
      const exists = state.edges.some((e) => e.id === row.id);
      return {
        edges: exists ? state.edges.map((e) => (e.id === row.id ? edge : e)) : [...state.edges, edge],
      };
    });
  },

  applyRemoteGeneration: (change) => {
    const row = change.new as GenerationRow;
    if (!row?.id) return;
    // 把生成进度 / 状态投影到关联占位节点的 data（运行时字段）
    const nodeId = row.placeholder_node_id;
    if (!nodeId) return;
    set((state) => ({
      nodes: state.nodes.map((n) => {
        if (n.id !== nodeId || n.data.type !== 'generation_placeholder') return n;
        return {
          ...n,
          data: {
            ...n.data,
            progress: row.progress,
            statusLabel: row.status,
            errorMessage: row.error,
          },
        };
      }),
    }));
  },

  restoreGraph: (nodes, edges) => {
    const state = get();
    const prevNodeIds = new Set(state.nodes.map((n) => n.id));
    const nextNodeIds = new Set(nodes.map((n) => n.id));
    const dirtyNodes = new Set(state._dirtyNodeIds);
    const deletedNodes = new Set(state._deletedNodeIds);
    for (const id of nextNodeIds) dirtyNodes.add(id);
    for (const id of prevNodeIds) if (!nextNodeIds.has(id)) deletedNodes.add(id);

    const prevEdgeIds = new Set(state.edges.map((e) => e.id));
    const nextEdgeIds = new Set(edges.map((e) => e.id));
    const dirtyEdges = new Set(state._dirtyEdgeIds);
    const deletedEdges = new Set(state._deletedEdgeIds);
    for (const id of nextEdgeIds) dirtyEdges.add(id);
    for (const id of prevEdgeIds) if (!nextEdgeIds.has(id)) deletedEdges.add(id);

    set({
      nodes,
      edges,
      selectedNodeIds: state.selectedNodeIds.filter((id) => nextNodeIds.has(id)),
      _dirtyNodeIds: dirtyNodes,
      _deletedNodeIds: deletedNodes,
      _dirtyEdgeIds: dirtyEdges,
      _deletedEdgeIds: deletedEdges,
    });
  },

  markNodePersisted: (id, updatedAt) => {
    set((state) => ({ _nodeVersions: { ...state._nodeVersions, [id]: updatedAt } }));
  },

  flushDirty: () => {
    const state = get();
    const nodeById = new Map(state.nodes.map((n) => [n.id, n]));
    const edgeById = new Map(state.edges.map((e) => [e.id, e]));

    const upserts: CanvasFlowNode[] = [];
    for (const id of state._dirtyNodeIds) {
      const node = nodeById.get(id);
      if (node) upserts.push(node);
    }
    const edgeUpserts: CanvasFlowEdge[] = [];
    for (const id of state._dirtyEdgeIds) {
      const edge = edgeById.get(id);
      if (edge) edgeUpserts.push(edge);
    }

    const flush: DirtyFlush = {
      upserts,
      deletes: Array.from(state._deletedNodeIds),
      edgeUpserts,
      edgeDeletes: Array.from(state._deletedEdgeIds),
    };

    set({
      _dirtyNodeIds: new Set(),
      _deletedNodeIds: new Set(),
      _dirtyEdgeIds: new Set(),
      _deletedEdgeIds: new Set(),
    });

    return flush;
  },

  flushViewportDirty: () => {
    const dirty = get()._viewportDirty;
    if (dirty) set({ _viewportDirty: false });
    return dirty;
  },
}));
