/**
 * Flow Studio 实例级 Zustand Store。
 *
 * 每个挂载的 WorkflowProvider 都创建独立 store；数据库仍是唯一真相，本地仅保存乐观投影、
 * dirty 集合和运行快照。
 *
 * @module stores/workflow-store
 */

import { createStore, type StoreApi } from 'zustand/vanilla';
import type {
  WorkflowEdgeRow,
  WorkflowGraphEdge,
  WorkflowGraphNode,
  WorkflowNodeConfig,
  WorkflowNodeRow,
  WorkflowRunNodeRow,
  WorkflowRunOutputRow,
  WorkflowRunRow,
  WorkflowValidationProblem,
} from '@/types';
import { workflowDescendants } from '@/types';
import { validateWorkflowGraph } from '@/lib/workflow/registry';

export type WorkflowSyncStatus = 'saved' | 'saving' | 'offline' | 'error';

/** Flow Store 状态与动作。 */
export interface WorkflowState {
  workflowId: string;
  graphRevision: number;
  nodes: WorkflowGraphNode[];
  edges: WorkflowGraphEdge[];
  selectedNodeId: string | null;
  problems: WorkflowValidationProblem[];
  staleNodeIds: Set<string>;
  runs: WorkflowRunRow[];
  runNodes: WorkflowRunNodeRow[];
  outputs: WorkflowRunOutputRow[];
  activeRunId: string | null;
  dirtyNodeIds: Set<string>;
  dirtyEdgeIds: Set<string>;
  deletedNodeIds: Set<string>;
  deletedEdgeIds: Set<string>;
  changeEpoch: number;
  syncStatus: WorkflowSyncStatus;
  syncError: string | null;
  hydrateGraph: (revision: number, nodes: WorkflowNodeRow[], edges: WorkflowEdgeRow[]) => void;
  hydrateRuns: (
    runs: WorkflowRunRow[],
    runNodes: WorkflowRunNodeRow[],
    outputs: WorkflowRunOutputRow[],
  ) => void;
  setActiveRun: (runId: string | null) => void;
  setSelection: (nodeId: string | null) => void;
  addNode: (node: WorkflowGraphNode) => void;
  updateNodePosition: (nodeId: string, position: { x: number; y: number }) => void;
  updateNodeConfig: (nodeId: string, config: WorkflowNodeConfig) => void;
  removeNode: (nodeId: string) => void;
  addEdge: (edge: WorkflowGraphEdge) => boolean;
  removeEdge: (edgeId: string) => void;
  markSaving: () => void;
  markSyncFailure: (message: string, offline?: boolean) => void;
  clearDirty: (flushedEpoch: number, graphRevision?: number) => void;
  reconcileWorkflowRevision: (revision: number) => void;
  reconcileNode: (row: WorkflowNodeRow | null, deletedId?: string) => void;
  reconcileEdge: (row: WorkflowEdgeRow | null, deletedId?: string) => void;
}

/** 数据库节点行转图节点。 */
export function workflowNodeRowToGraph(row: WorkflowNodeRow): WorkflowGraphNode {
  return {
    id: row.id,
    kind: row.kind,
    position: { x: row.position_x, y: row.position_y },
    config: row.config,
    schemaVersion: row.schema_version,
  };
}

/** 数据库边行转图边。 */
export function workflowEdgeRowToGraph(row: WorkflowEdgeRow): WorkflowGraphEdge {
  return {
    id: row.id,
    sourceNodeId: row.source_node_id,
    sourcePort: row.source_port,
    targetNodeId: row.target_node_id,
    targetPort: row.target_port,
    valueType: row.value_type,
  };
}

function withValidation(nodes: WorkflowGraphNode[], edges: WorkflowGraphEdge[]) {
  return { nodes, edges, problems: validateWorkflowGraph({ nodes, edges }) };
}

/** 创建一个工作流专属 store。 */
export function createWorkflowStore(workflowId: string): StoreApi<WorkflowState> {
  return createStore<WorkflowState>((set, get) => ({
    workflowId,
    graphRevision: 0,
    nodes: [],
    edges: [],
    selectedNodeId: null,
    problems: [],
    staleNodeIds: new Set(),
    runs: [],
    runNodes: [],
    outputs: [],
    activeRunId: null,
    dirtyNodeIds: new Set(),
    dirtyEdgeIds: new Set(),
    deletedNodeIds: new Set(),
    deletedEdgeIds: new Set(),
    changeEpoch: 0,
    syncStatus: 'saved',
    syncError: null,
    hydrateGraph: (revision, rows, edgeRows) => {
      const nodes = rows.map(workflowNodeRowToGraph);
      const edges = edgeRows.map(workflowEdgeRowToGraph);
      set({
        graphRevision: revision,
        ...withValidation(nodes, edges),
        dirtyNodeIds: new Set(),
        dirtyEdgeIds: new Set(),
        deletedNodeIds: new Set(),
        deletedEdgeIds: new Set(),
        syncStatus: 'saved',
        syncError: null,
      });
    },
    hydrateRuns: (runs, runNodes, outputs) =>
      set((state) => ({
        runs,
        runNodes,
        outputs,
        activeRunId:
          state.activeRunId && runs.some((run) => run.id === state.activeRunId)
            ? state.activeRunId
            : (runs[0]?.id ?? null),
      })),
    setActiveRun: (activeRunId) => set({ activeRunId }),
    setSelection: (selectedNodeId) => set({ selectedNodeId }),
    addNode: (node) =>
      set((state) => {
        const nodes = [...state.nodes, node];
        return {
          ...withValidation(nodes, state.edges),
          selectedNodeId: node.id,
          dirtyNodeIds: new Set(state.dirtyNodeIds).add(node.id),
          deletedNodeIds: new Set([...state.deletedNodeIds].filter((id) => id !== node.id)),
          staleNodeIds: new Set(state.staleNodeIds).add(node.id),
          changeEpoch: state.changeEpoch + 1,
        };
      }),
    updateNodePosition: (nodeId, position) =>
      set((state) => ({
        nodes: state.nodes.map((node) => (node.id === nodeId ? { ...node, position } : node)),
        dirtyNodeIds: new Set(state.dirtyNodeIds).add(nodeId),
        changeEpoch: state.changeEpoch + 1,
      })),
    updateNodeConfig: (nodeId, config) =>
      set((state) => {
        const nodes = state.nodes.map((node) => (node.id === nodeId ? { ...node, config } : node));
        const stale = workflowDescendants({ nodes, edges: state.edges }, [nodeId]);
        return {
          ...withValidation(nodes, state.edges),
          dirtyNodeIds: new Set(state.dirtyNodeIds).add(nodeId),
          staleNodeIds: new Set([...state.staleNodeIds, ...stale]),
          changeEpoch: state.changeEpoch + 1,
        };
      }),
    removeNode: (nodeId) =>
      set((state) => {
        const removedEdges = state.edges.filter(
          (edge) => edge.sourceNodeId === nodeId || edge.targetNodeId === nodeId,
        );
        const nodes = state.nodes.filter((node) => node.id !== nodeId);
        const edges = state.edges.filter((edge) => !removedEdges.includes(edge));
        return {
          ...withValidation(nodes, edges),
          selectedNodeId: state.selectedNodeId === nodeId ? null : state.selectedNodeId,
          deletedNodeIds: new Set(state.deletedNodeIds).add(nodeId),
          deletedEdgeIds: new Set([
            ...state.deletedEdgeIds,
            ...removedEdges.map((edge) => edge.id),
          ]),
          dirtyNodeIds: new Set([...state.dirtyNodeIds].filter((id) => id !== nodeId)),
          dirtyEdgeIds: new Set(
            [...state.dirtyEdgeIds].filter((id) => !removedEdges.some((edge) => edge.id === id)),
          ),
          changeEpoch: state.changeEpoch + 1,
        };
      }),
    addEdge: (edge) => {
      const state = get();
      const edges = [...state.edges, edge];
      const problems = validateWorkflowGraph({ nodes: state.nodes, edges });
      if (
        problems.some(
          (problem) =>
            problem.edgeId === edge.id ||
            problem.code === 'cycle' ||
            problem.code === 'duplicate_input',
        )
      )
        return false;
      set({
        edges,
        problems,
        dirtyEdgeIds: new Set(state.dirtyEdgeIds).add(edge.id),
        staleNodeIds: new Set([
          ...state.staleNodeIds,
          ...workflowDescendants({ nodes: state.nodes, edges }, [edge.targetNodeId]),
        ]),
        changeEpoch: state.changeEpoch + 1,
      });
      return true;
    },
    removeEdge: (edgeId) =>
      set((state) => {
        const edge = state.edges.find((item) => item.id === edgeId);
        const edges = state.edges.filter((item) => item.id !== edgeId);
        return {
          edges,
          problems: validateWorkflowGraph({ nodes: state.nodes, edges }),
          deletedEdgeIds: new Set(state.deletedEdgeIds).add(edgeId),
          dirtyEdgeIds: new Set([...state.dirtyEdgeIds].filter((id) => id !== edgeId)),
          staleNodeIds: edge
            ? new Set([
                ...state.staleNodeIds,
                ...workflowDescendants({ nodes: state.nodes, edges }, [edge.targetNodeId]),
              ])
            : state.staleNodeIds,
          changeEpoch: state.changeEpoch + 1,
        };
      }),
    markSaving: () => set({ syncStatus: 'saving', syncError: null }),
    markSyncFailure: (message, offline = false) =>
      set({
        syncStatus: offline ? 'offline' : 'error',
        syncError: message,
      }),
    clearDirty: (flushedEpoch, graphRevision) =>
      set((state) => {
        if (state.changeEpoch !== flushedEpoch) {
          return {
            graphRevision: graphRevision ?? state.graphRevision,
            syncStatus: 'saving',
            syncError: null,
          };
        }
        return {
          graphRevision: graphRevision ?? state.graphRevision,
          dirtyNodeIds: new Set(),
          dirtyEdgeIds: new Set(),
          deletedNodeIds: new Set(),
          deletedEdgeIds: new Set(),
          syncStatus: 'saved',
          syncError: null,
        };
      }),
    reconcileWorkflowRevision: (graphRevision) => set({ graphRevision }),
    reconcileNode: (row, deletedId) =>
      set((state) => {
        const id = row?.id ?? deletedId;
        if (!id || state.dirtyNodeIds.has(id) || state.deletedNodeIds.has(id)) return state;
        const nodes = row
          ? [...state.nodes.filter((node) => node.id !== row.id), workflowNodeRowToGraph(row)]
          : state.nodes.filter((node) => node.id !== id);
        return { ...withValidation(nodes, state.edges) };
      }),
    reconcileEdge: (row, deletedId) =>
      set((state) => {
        const id = row?.id ?? deletedId;
        if (!id || state.dirtyEdgeIds.has(id) || state.deletedEdgeIds.has(id)) return state;
        const edges = row
          ? [...state.edges.filter((edge) => edge.id !== row.id), workflowEdgeRowToGraph(row)]
          : state.edges.filter((edge) => edge.id !== id);
        return { ...withValidation(state.nodes, edges) };
      }),
  }));
}
