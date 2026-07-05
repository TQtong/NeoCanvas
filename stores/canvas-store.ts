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

import {
  applyEdgeChanges,
  applyNodeChanges,
  type EdgeChange,
  type NodeChange,
} from '@xyflow/react';
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
import { generationRowToView } from '@/lib/data/mappers';
import {
  decorateSequenceEdge,
  SEQUENCE_EDGE_TYPE,
  SEQUENCE_HANDLE_IN,
  SEQUENCE_HANDLE_OUT,
  wouldCreateSequenceCycle,
} from '@/lib/canvas/sequence';
import {
  ANNOTATION_EDGE_TYPE,
  ANNOTATION_HANDLE_OUT,
  decorateAnnotationEdge,
} from '@/lib/canvas/annotation';
import { DEFAULT_VIEWPORT, PASTE_OFFSET } from '@/lib/canvas/constants';
import { uuid } from '@/lib/utils/id';

/** 画布工具，对应底部工具栏的十个工具（第 01 篇、第 04 篇 4.9）。 */
export type CanvasTool =
  | 'select'
  | 'pan'
  | 'upload-media'
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
  /** 已 flush、写回未确认的边 id（在途持久化）；用于抑制自身写入的边回声。 */
  _pendingEdgeIds: Set<string>;
  /** 节点服务端版本（updated_at），用于回声抑制与最后写入胜出。 */
  _nodeVersions: Record<string, string>;
  /** 已 flush、写回未确认的节点 id（在途持久化）；用于抑制自身写入的回声。 */
  _pendingNodeIds: Set<string>;
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
  /** 添加一个节点。`persist:false` 仅本地添加、不标脏（用于服务端为唯一写者的场景，如失败还原）。 */
  addNode: (node: CanvasFlowNode, options?: { select?: boolean; persist?: boolean }) => void;
  /** 批量添加节点。`persist:false` 仅本地添加、不标脏。 */
  addNodes: (nodes: CanvasFlowNode[], options?: { select?: boolean; persist?: boolean }) => void;
  /** 更新节点（合并顶层字段）。 */
  updateNode: (id: string, patch: Partial<CanvasFlowNode>) => void;
  /** 更新节点 data（合并），标记脏集以持久化。 */
  updateNodeData: (id: string, dataPatch: Partial<NodeData>) => void;
  /** 仅更新运行时 data 字段（如签名 URL、进度），不标记脏集、不触发持久化。 */
  setNodeRuntime: (id: string, dataPatch: Partial<NodeData>) => void;
  /**
   * 删除节点（连带其作为父的子节点解除父子并删自身、清理相连边）。
   * `persist:false` 仅本地移除、不记录删除、不回写 DB（写入权归服务端 + 实时回流，用于原地
   * 重生成时乐观移除将由服务端删除的节点，避免依赖 realtime DELETE 才能收敛）。
   */
  removeNodes: (ids: string[], options?: { persist?: boolean }) => void;
  /**
   * 替换某节点（用于占位转化等整节点替换）。
   *
   * `options.persist` 缺省为 true：标脏并经持久化控制器回写。置为 false 时只做本地即时替换、
   * 不标脏、并清除该 id 可能存在的脏标记——用于「该行的写入权完全归服务端 + 实时回流」的场景
   * （如原地相似再生成：服务端 createGeneration 已 upsert 占位、landResult 落图，客户端若再写
   * 同一行会与之竞态、可能把已落的结果覆盖回空占位）。
   */
  replaceNode: (id: string, node: CanvasFlowNode, options?: { persist?: boolean }) => void;

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
  /** 在「点状 → 线状 → 无」三态间循环切换背景网格（画板 / 网格工具）。 */
  cycleBackground: () => void;
  toggleLayers: () => void;
  setContinuousCreate: (value: boolean) => void;

  // ----- 层级 -----
  bringToFront: (ids: string[]) => void;
  sendToBack: (ids: string[]) => void;
  moveForward: (ids: string[]) => void;
  moveBackward: (ids: string[]) => void;
  reorderNode: (id: string, targetZIndex: number) => void;
  /** 按「自顶向下」顺序重排参与节点的 z_index（图层列表拖拽改序）。 */
  setLayerOrder: (orderedIdsTopFirst: string[]) => void;

  // ----- 剪贴板 -----
  copySelection: () => void;
  paste: () => void;
  duplicateSelection: () => void;
  /**
   * 把选中的顶层节点（≥2 个）成组：以其包围盒新建一个透明画板容器，把它们 reparent 为该容器
   * 的子节点（坐标转相对、extent:'parent'），此后拖动容器即整体移动；子节点仍可单独编辑。
   */
  groupSelection: () => void;
  /**
   * 解组：把选中的成组关系拆开——选中组容器或其任一子节点皆可。子节点 parent 清空、坐标转回
   * 绝对；纯组容器（frame）解组后删除，内容父节点（如海报背景图）保留。
   */
  ungroupSelection: () => void;

  // ----- 交互瞬态 -----
  setMarquee: (marquee: MarqueeState | null) => void;
  setGuides: (guides: AlignmentGuide[]) => void;

  // ----- 边 -----
  addEdge: (edge: CanvasFlowEdge) => void;
  removeEdges: (ids: string[]) => void;
  /**
   * 串接一条工作流序列边 `source → target`：n:m 自由连接（同一媒体节点可有多条出 / 入边），
   * 去重已存在的同向边，并拒绝会成环的连接（保持有向无环）。
   *
   * @returns 实际创建的边 id；当被去重 / 拒环而未创建时返回 null。
   */
  addSequenceEdge: (
    source: string,
    target: string,
    sourceHandle?: string | null,
    targetHandle?: string | null,
  ) => string | null;
  /**
   * 串接一条图片描述边 `note → image`：强制一对一（替换该便签既有描述、替换该图既有描述），
   * 去重已存在的同向边。
   *
   * @returns 实际创建的边 id；当被去重而未创建时返回 null。
   */
  addAnnotationEdge: (
    source: string,
    target: string,
    sourceHandle?: string | null,
    targetHandle?: string | null,
  ) => string | null;

  // ----- 远端回流 -----
  applyRemoteNode: (change: RealtimeChange<CanvasNodeRow>) => void;
  applyRemoteEdge: (change: RealtimeChange<CanvasEdgeRow>) => void;
  applyRemoteGeneration: (change: RealtimeChange<GenerationRow>) => void;

  // ----- 持久化协调 -----
  /** 以快照整体替换节点 / 边（用于撤销 / 重做），并据差异标记脏 / 删除集以持久化。 */
  restoreGraph: (nodes: CanvasFlowNode[], edges: CanvasFlowEdge[]) => void;
  /** 标记某节点已持久化（记录服务端版本并清除在途标记，用于回声抑制）。 */
  markNodePersisted: (id: string, updatedAt: string) => void;
  /** 标记一批节点持久化失败：清除在途标记，使后续真正的远端变更可正常套用。 */
  markPersistFailed: (ids: string[]) => void;
  /** 标记一批边已持久化（清除在途标记，用于边回声抑制）。 */
  markEdgesPersisted: (ids: string[]) => void;
  /** 标记一批边持久化失败：清除在途标记，使后续真正的远端变更可正常套用。 */
  markEdgesPersistFailed: (ids: string[]) => void;
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
  _pendingNodeIds: new Set(),
  _pendingEdgeIds: new Set(),
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
      _pendingNodeIds: new Set(),
      _pendingEdgeIds: new Set(),
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
      _pendingNodeIds: new Set(),
      _pendingEdgeIds: new Set(),
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

    // 注：不做「选中成员→整组选中」联动——单击成员即单独选中它，便于单独编辑（替换 / 再生成等）；
    // 整组一起移动由 CanvasContainer 的 onNodeDrag 主动跟随保证。
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
    const select = options?.select ?? true;
    const persist = options?.persist !== false;
    set((state) => {
      const base = {
        nodes: [...state.nodes, ...newNodes],
        selectedNodeIds: select ? newNodes.map((n) => n.id) : state.selectedNodeIds,
      };
      if (!persist) return base;
      const dirty = new Set(state._dirtyNodeIds);
      for (const n of newNodes) dirty.add(n.id);
      return { ...base, _dirtyNodeIds: dirty };
    });
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

  removeNodes: (ids, options) => {
    const persist = options?.persist !== false;
    const idSet = new Set(ids);
    const state = get();
    // 与被删节点相连的边（source/target 命中其一）：随节点一并从本地移除，避免悬挂边
    const incidentEdgeIds = new Set(
      state.edges.filter((e) => idSet.has(e.source) || idSet.has(e.target)).map((e) => e.id),
    );
    const nextNodes = state.nodes
      .filter((n) => !idSet.has(n.id))
      // 解除以被删节点为父的子节点的父子关系
      .map((n) =>
        n.parentId && idSet.has(n.parentId) ? { ...n, parentId: undefined, extent: undefined } : n,
      );
    const nextEdges = state.edges.filter((e) => !incidentEdgeIds.has(e.id));
    const nextSelection = state.selectedNodeIds.filter((sid) => !idSet.has(sid));

    if (!persist) {
      // 仅本地移除：不记录删除、不回写 DB；清除相关脏标记，确保客户端不再写这些行
      const dirty = new Set(state._dirtyNodeIds);
      const edgeDirty = new Set(state._dirtyEdgeIds);
      for (const id of ids) dirty.delete(id);
      for (const eid of incidentEdgeIds) edgeDirty.delete(eid);
      set({
        nodes: nextNodes,
        edges: nextEdges,
        selectedNodeIds: nextSelection,
        _dirtyNodeIds: dirty,
        _dirtyEdgeIds: edgeDirty,
      });
      return;
    }

    // 默认：记录节点 / 边删除以供持久化回写（与 React Flow 删除键的级联语义对齐，避免外键违例）
    const deleted = new Set(state._deletedNodeIds);
    const dirty = new Set(state._dirtyNodeIds);
    for (const id of ids) {
      deleted.add(id);
      dirty.delete(id);
    }
    const edgeDirty = new Set(state._dirtyEdgeIds);
    const edgeDeleted = new Set(state._deletedEdgeIds);
    for (const eid of incidentEdgeIds) {
      edgeDeleted.add(eid);
      edgeDirty.delete(eid);
    }
    set({
      nodes: nextNodes,
      edges: nextEdges,
      selectedNodeIds: nextSelection,
      _deletedNodeIds: deleted,
      _dirtyNodeIds: dirty,
      _dirtyEdgeIds: edgeDirty,
      _deletedEdgeIds: edgeDeleted,
    });
  },

  replaceNode: (id, node, options) => {
    const persist = options?.persist !== false;
    set((state) => {
      const nodes = state.nodes.map((n) => (n.id === id ? node : n));
      if (persist) {
        const dirty = new Set(state._dirtyNodeIds);
        dirty.add(node.id);
        return { nodes, _dirtyNodeIds: dirty };
      }
      // 不持久化：清除该行的脏标记，确保客户端不再回写此行（写入权交给服务端 + 实时回流）
      if (state._dirtyNodeIds.has(id) || state._dirtyNodeIds.has(node.id)) {
        const dirty = new Set(state._dirtyNodeIds);
        dirty.delete(id);
        dirty.delete(node.id);
        return { nodes, _dirtyNodeIds: dirty };
      }
      return { nodes };
    });
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

  setTool: (tool) =>
    set({ activeTool: tool, editingNodeId: tool === 'text' ? get().editingNodeId : null }),
  setEditingNode: (id) => set({ editingNodeId: id }),

  setViewport: (viewport, options) =>
    set({ viewport, _viewportDirty: options?.persist ?? get()._viewportDirty }),

  setBackground: (background) =>
    set((state) => ({ background: { ...state.background, ...background } })),

  cycleBackground: () =>
    set((state) => {
      const order = ['dots', 'lines', 'none'] as const;
      const idx = order.indexOf(state.background.variant as (typeof order)[number]);
      const next = order[(idx + 1) % order.length] ?? 'dots';
      return { background: { ...state.background, variant: next } };
    }),

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

  setLayerOrder: (orderedIdsTopFirst) => {
    const dirty = new Set(get()._dirtyNodeIds);
    const zById = new Map<string, number>();
    const total = orderedIdsTopFirst.length;
    orderedIdsTopFirst.forEach((id, i) => {
      zById.set(id, total - i); // 顶层 z 最大
      dirty.add(id);
    });
    set((state) => ({
      nodes: state.nodes.map((n) =>
        zById.has(n.id) ? { ...n, zIndex: zById.get(n.id) as number } : n,
      ),
      _dirtyNodeIds: dirty,
    }));
  },

  copySelection: () => {
    const { nodes, selectedNodeIds } = get();
    const sel = new Set(selectedNodeIds);
    set({
      clipboard: nodes.filter((n) => sel.has(n.id)).map((n) => ({ ...n, data: { ...n.data } })),
    });
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

  groupSelection: () => {
    const state = get();
    const selectedIds = new Set(state.selectedNodeIds);
    const members = state.nodes.filter((n) => selectedIds.has(n.id));
    if (members.length < 2) return;

    // PPT / Figma 式逻辑组：给全部成员打同一 groupId（无容器、不依赖位置是否相邻、不改父子）。
    // 既有不同组的成员会被合并进新组。持久化于 data.groupId。
    const groupId = uuid();
    const memberIds = new Set(members.map((n) => n.id));
    const dirty = new Set(state._dirtyNodeIds);
    const nodes = state.nodes.map((n) => {
      if (!memberIds.has(n.id)) return n;
      dirty.add(n.id);
      return { ...n, data: { ...n.data, groupId }, selected: true };
    });
    set({ nodes, _dirtyNodeIds: dirty });
  },

  ungroupSelection: () => {
    const state = get();
    const selectedIds = new Set(state.selectedNodeIds);

    // 解组涉及：① 逻辑组 groupId；② parent_id 容器（兼容画板 frame 与历史海报「图当容器」）。
    // 选中容器本身或其任一子节点皆可触发。
    const groupIds = new Set<string>();
    const containerIds = new Set<string>();
    for (const n of state.nodes) {
      if (!selectedIds.has(n.id)) continue;
      if (n.data.groupId) groupIds.add(n.data.groupId);
      if (state.nodes.some((c) => c.parentId === n.id)) containerIds.add(n.id);
      if (n.parentId) containerIds.add(n.parentId);
    }
    if (groupIds.size === 0 && containerIds.size === 0) return;

    const dirty = new Set(state._dirtyNodeIds);
    const deleted = new Set(state._deletedNodeIds);
    const posById = new Map(state.nodes.map((n) => [n.id, n.position]));

    let nodes = state.nodes.map((n) => {
      let next = n;
      // 清逻辑组标记
      if (n.data.groupId && groupIds.has(n.data.groupId)) {
        next = { ...next, data: { ...next.data, groupId: undefined } };
        dirty.add(n.id);
      }
      // 解父子容器：子节点坐标转回绝对、清 parent / extent
      if (n.parentId && containerIds.has(n.parentId)) {
        const p = posById.get(n.parentId);
        next = {
          ...next,
          parentId: undefined,
          extent: undefined,
          position: { x: next.position.x + (p?.x ?? 0), y: next.position.y + (p?.y ?? 0) },
        };
        dirty.add(n.id);
      }
      return next;
    });

    // 纯 frame 组容器解组后删除（无内容意义）；内容父节点（如海报背景图）保留为独立节点
    for (const cid of containerIds) {
      const c = state.nodes.find((n) => n.id === cid);
      if (c?.data.type === 'frame') {
        deleted.add(cid);
        dirty.delete(cid);
        nodes = nodes.filter((n) => n.id !== cid);
      }
    }

    set({ nodes, _dirtyNodeIds: dirty, _deletedNodeIds: deleted });
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
    const dirty = new Set(get()._dirtyEdgeIds);
    for (const id of ids) {
      deleted.add(id);
      dirty.delete(id); // 同步清脏集：刚建即删的边不应再作为 upsert 写回
    }
    set((state) => ({
      edges: state.edges.filter((e) => !idSet.has(e.id)),
      _dirtyEdgeIds: dirty,
      _deletedEdgeIds: deleted,
    }));
  },

  addSequenceEdge: (source, target, sourceHandle, targetHandle) => {
    if (source === target) return null;
    const state = get();
    const seqEdges = state.edges.filter((e) => e.type === SEQUENCE_EDGE_TYPE);
    // 已存在同向序列边：去重
    if (seqEdges.some((e) => e.source === source && e.target === target)) return null;
    // 会成环：拒绝（保持工作流为有向无环图，关键帧顺序方可良定义）
    if (wouldCreateSequenceCycle(state.edges, source, target)) return null;

    // n:m：不再移除源既有出边 / 目标既有入边——同一媒体节点可有多条出边与入边，自由连成 DAG
    const id = uuid();
    // 写入连接桩 id（默认右出桩 → 左入桩），持久化到 source_handle / target_handle，保证重载锚点一致
    const edge = decorateSequenceEdge({
      id,
      source,
      target,
      sourceHandle: sourceHandle ?? SEQUENCE_HANDLE_OUT,
      targetHandle: targetHandle ?? SEQUENCE_HANDLE_IN,
      data: {},
    });

    const dirty = new Set(state._dirtyEdgeIds);
    dirty.add(id);
    set((s) => ({ edges: [...s.edges, edge], _dirtyEdgeIds: dirty }));
    return id;
  },

  addAnnotationEdge: (source, target, sourceHandle, targetHandle) => {
    if (source === target) return null;
    const state = get();
    const annEdges = state.edges.filter((e) => e.type === ANNOTATION_EDGE_TYPE);
    // 已存在同向描述边：去重
    if (annEdges.some((e) => e.source === source && e.target === target)) return null;
    // 一对一：移除该便签既有描述出边、该图既有描述入边
    const supersededIds = annEdges
      .filter((e) => e.source === source || e.target === target)
      .map((e) => e.id);

    const id = uuid();
    const edge = decorateAnnotationEdge({
      id,
      source,
      target,
      sourceHandle: sourceHandle ?? ANNOTATION_HANDLE_OUT,
      targetHandle: targetHandle ?? SEQUENCE_HANDLE_IN,
      data: {},
    });

    const dirty = new Set(state._dirtyEdgeIds);
    const deleted = new Set(state._deletedEdgeIds);
    for (const sid of supersededIds) {
      deleted.add(sid);
      dirty.delete(sid);
    }
    dirty.add(id);

    const supersededSet = new Set(supersededIds);
    set((s) => ({
      edges: [...s.edges.filter((e) => !supersededSet.has(e.id)), edge],
      _dirtyEdgeIds: dirty,
      _deletedEdgeIds: deleted,
    }));
    return id;
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

    const local = get();
    // 生成完成事件：占位节点就地转为真实节点（image/video）。当客户端预建了占位 id
    // （「以此再生成」路径），该转化会落在「在途/版本」抑制范围内而被吞掉，导致永远停在占位态。
    // 故对「占位 → 真实类型」的转化豁免回声抑制与版本守卫，保证落图一定渲染。
    const localNode = local.nodes.find((n) => n.id === row.id);
    const isGenerationCompletion =
      localNode?.data.type === 'generation_placeholder' && row.type !== 'generation_placeholder';

    if (!isGenerationCompletion) {
      // 回声抑制：本地仍有在途变更（脏 / 待持久化确认 / 正在就地编辑）的节点，以本地为准，
      // 忽略回流——这正是用「客户端在途标识」识别并抑制自身写入回声，避免覆盖正在编辑的节点
      // （第 04 篇第五节）。在途变更持久化后会经 markNodePersisted 记录服务端版本，
      // 后续真正的远端变更再据 updated_at 做最后写入胜出。
      if (
        local._dirtyNodeIds.has(row.id) ||
        local._pendingNodeIds.has(row.id) ||
        local.editingNodeId === row.id
      ) {
        return;
      }

      // 最后写入胜出：远端版本不新于本地已知版本则忽略
      const localVersion = local._nodeVersions[row.id];
      if (notOlderThan(localVersion, row.updated_at)) return;
    }

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
    // 回声抑制：本地仍有该边的在途变更（脏 / 待持久化确认 / 刚被删除）时以本地为准，忽略自身
    // 写入回流——边表无 updated_at，故以脏 / 在途 / 待删三集联合识别回声，避免迟到的 INSERT 回声
    // 复活已被用户删除的边。
    const local = get();
    if (
      local._dirtyEdgeIds.has(row.id) ||
      local._pendingEdgeIds.has(row.id) ||
      local._deletedEdgeIds.has(row.id)
    ) {
      return;
    }
    const edge = rowToEdge(row);
    set((state) => {
      const exists = state.edges.some((e) => e.id === row.id);
      return {
        edges: exists
          ? state.edges.map((e) => (e.id === row.id ? edge : e))
          : [...state.edges, edge],
      };
    });
  },

  applyRemoteGeneration: (change) => {
    const row = change.new as GenerationRow;
    if (!row?.id) return;
    // 经统一映射得到生成视图，再把进度 / 状态投影到关联占位节点的 data（运行时字段）
    const view = generationRowToView(row);
    const nodeId = view.placeholderNodeId;
    if (!nodeId) return;
    set((state) => ({
      nodes: state.nodes.map((n) => {
        if (n.id !== nodeId || n.data.type !== 'generation_placeholder') return n;
        return {
          ...n,
          data: {
            ...n.data,
            progress: view.progress,
            statusLabel: view.status,
            errorMessage: view.error,
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
    set((state) => {
      const pending = new Set(state._pendingNodeIds);
      pending.delete(id);
      return {
        _nodeVersions: { ...state._nodeVersions, [id]: updatedAt },
        _pendingNodeIds: pending,
      };
    });
  },

  markPersistFailed: (ids) => {
    set((state) => {
      const pending = new Set(state._pendingNodeIds);
      for (const id of ids) pending.delete(id);
      return { _pendingNodeIds: pending };
    });
  },

  markEdgesPersisted: (ids) => {
    set((state) => {
      const pending = new Set(state._pendingEdgeIds);
      for (const id of ids) pending.delete(id);
      return { _pendingEdgeIds: pending };
    });
  },

  markEdgesPersistFailed: (ids) => {
    set((state) => {
      const pending = new Set(state._pendingEdgeIds);
      for (const id of ids) pending.delete(id);
      return { _pendingEdgeIds: pending };
    });
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

    // 把本批 upsert 的节点 / 边标记为「在途持久化」，在确认 / 失败前抑制其自身回声
    const pending = new Set(state._pendingNodeIds);
    for (const node of upserts) pending.add(node.id);
    const pendingEdges = new Set(state._pendingEdgeIds);
    for (const edge of edgeUpserts) pendingEdges.add(edge.id);

    set({
      _dirtyNodeIds: new Set(),
      _deletedNodeIds: new Set(),
      _dirtyEdgeIds: new Set(),
      _deletedEdgeIds: new Set(),
      _pendingNodeIds: pending,
      _pendingEdgeIds: pendingEdges,
    });

    return flush;
  },

  flushViewportDirty: () => {
    const dirty = get()._viewportDirty;
    if (dirty) set({ _viewportDirty: false });
    return dirty;
  },
}));
