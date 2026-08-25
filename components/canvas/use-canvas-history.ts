'use client';

/**
 * 画布操作差异式撤销 / 重做。
 *
 * 历史条目只保存本次操作涉及实体的 before/after。拖拽、缩放和旋转通过 Store 的显式事务边界
 * 合并；文本等无显式边界的连续编辑使用短防抖合并。运行时签名 URL、选择态和 Realtime 回流
 * 不进入本地历史，undo/redo 仍通过普通 dirty/outbox 管道持久化。
 *
 * @module components/canvas/use-canvas-history
 */

import { useCallback, useEffect, useRef } from 'react';
import { useCanvasStore, type CanvasHistoryPatch } from '@/stores/canvas-store';
import { nodeToColumns, type CanvasFlowEdge, type CanvasFlowNode } from '@/lib/canvas/node-mapper';
import { uuid } from '@/lib/utils/id';

/** 历史栈最大深度。 */
const MAX_HISTORY = 60;
/** 无显式边界的连续编辑合并窗口。 */
const IMPLICIT_TRANSACTION_MS = 400;

/** 一条差异式历史事务。 */
export interface CanvasHistoryEntry {
  id: string;
  label: string;
  nodesBefore: Record<string, CanvasFlowNode | null>;
  nodesAfter: Record<string, CanvasFlowNode | null>;
  edgesBefore: Record<string, CanvasFlowEdge | null>;
  edgesAfter: Record<string, CanvasFlowEdge | null>;
  createdAt: string;
}

interface ActiveHistoryEntry {
  label: string;
  nodesBefore: Map<string, CanvasFlowNode | null>;
  nodesAfter: Map<string, CanvasFlowNode | null>;
  edgesBefore: Map<string, CanvasFlowEdge | null>;
  edgesAfter: Map<string, CanvasFlowEdge | null>;
}

/** useCanvasHistory 返回值。 */
export interface UseCanvasHistory {
  undo: () => void;
  redo: () => void;
}

/** 深拷贝节点的可持久化与运行时数据，隔离后续原地嵌套修改。 */
function cloneNode(node: CanvasFlowNode | undefined): CanvasFlowNode | null {
  if (!node) return null;
  return {
    ...node,
    position: { ...node.position },
    data: structuredClone(node.data),
    style: node.style ? structuredClone(node.style) : node.style,
  };
}

/** 深拷贝边数据。 */
function cloneEdge(edge: CanvasFlowEdge | undefined): CanvasFlowEdge | null {
  if (!edge) return null;
  return { ...edge, data: edge.data ? structuredClone(edge.data) : edge.data };
}

/** 只比较持久化字段，排除签名 URL、进度和选择态。 */
function nodeFingerprint(node: CanvasFlowNode | null): string {
  return node ? JSON.stringify(nodeToColumns(node)) : 'null';
}

/** 边的持久化指纹。 */
function edgeFingerprint(edge: CanvasFlowEdge | null): string {
  return edge
    ? JSON.stringify({
        source: edge.source,
        target: edge.target,
        sourceHandle: edge.sourceHandle ?? null,
        targetHandle: edge.targetHandle ?? null,
        type: edge.type ?? 'default',
        data: edge.data ?? {},
      })
    : 'null';
}

/** Map 转 Record，值已在捕获时隔离。 */
function mapToRecord<T>(map: Map<string, T>): Record<string, T> {
  return Object.fromEntries(map);
}

/**
 * 撤销 / 重做钩子。
 *
 * @param projectId - 当前项目（切换项目时清空历史）
 * @returns undo / redo 动作
 */
export function useCanvasHistory(projectId: string): UseCanvasHistory {
  const past = useRef<CanvasHistoryEntry[]>([]);
  const future = useRef<CanvasHistoryEntry[]>([]);
  const active = useRef<ActiveHistoryEntry | null>(null);
  const explicitTransaction = useRef(false);
  const isRestoring = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commitRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    past.current = [];
    future.current = [];
    active.current = null;
    explicitTransaction.current = false;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;

    /** 把有效差异提交到 past；操作最终回到原状时不产生空条目。 */
    const commit = (): void => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      const entry = active.current;
      active.current = null;
      if (!entry) return;

      for (const id of Array.from(entry.nodesBefore.keys())) {
        if (
          nodeFingerprint(entry.nodesBefore.get(id) ?? null) ===
          nodeFingerprint(entry.nodesAfter.get(id) ?? null)
        ) {
          entry.nodesBefore.delete(id);
          entry.nodesAfter.delete(id);
        }
      }
      for (const id of Array.from(entry.edgesBefore.keys())) {
        if (
          edgeFingerprint(entry.edgesBefore.get(id) ?? null) ===
          edgeFingerprint(entry.edgesAfter.get(id) ?? null)
        ) {
          entry.edgesBefore.delete(id);
          entry.edgesAfter.delete(id);
        }
      }
      if (entry.nodesBefore.size === 0 && entry.edgesBefore.size === 0) return;

      past.current.push({
        id: uuid(),
        label: entry.label,
        nodesBefore: mapToRecord(entry.nodesBefore),
        nodesAfter: mapToRecord(entry.nodesAfter),
        edgesBefore: mapToRecord(entry.edgesBefore),
        edgesAfter: mapToRecord(entry.edgesAfter),
        createdAt: new Date().toISOString(),
      });
      if (past.current.length > MAX_HISTORY) past.current.shift();
      future.current = [];
    };
    commitRef.current = commit;

    const unsubscribe = useCanvasStore.subscribe((state, previous) => {
      if (isRestoring.current) return;

      if (state._historyBoundary !== previous._historyBoundary && state._historyBoundary) {
        if (state._historyBoundary.phase === 'begin') {
          commit();
          explicitTransaction.current = true;
          active.current = {
            label: state._historyBoundary.label,
            nodesBefore: new Map(),
            nodesAfter: new Map(),
            edgesBefore: new Map(),
            edgesAfter: new Map(),
          };
        } else {
          if (active.current) active.current.label = state._historyBoundary.label;
          explicitTransaction.current = false;
          commit();
        }
      }

      if (state.nodes === previous.nodes && state.edges === previous.edges) return;
      const previousNodes = new Map(previous.nodes.map((node) => [node.id, node]));
      const currentNodes = new Map(state.nodes.map((node) => [node.id, node]));
      const nodeIds = new Set([
        ...state._dirtyNodeIds,
        ...previous._dirtyNodeIds,
        ...state._deletedNodeIds,
        ...previous._deletedNodeIds,
      ]);
      const previousEdges = new Map(previous.edges.map((edge) => [edge.id, edge]));
      const currentEdges = new Map(state.edges.map((edge) => [edge.id, edge]));
      const edgeIds = new Set([
        ...state._dirtyEdgeIds,
        ...previous._dirtyEdgeIds,
        ...state._deletedEdgeIds,
        ...previous._deletedEdgeIds,
      ]);

      let changed = false;
      const ensureActive = (): ActiveHistoryEntry => {
        active.current ??= {
          label: '画布操作',
          nodesBefore: new Map(),
          nodesAfter: new Map(),
          edgesBefore: new Map(),
          edgesAfter: new Map(),
        };
        return active.current;
      };

      for (const id of nodeIds) {
        const before = cloneNode(previousNodes.get(id));
        const after = cloneNode(currentNodes.get(id));
        if (nodeFingerprint(before) === nodeFingerprint(after)) continue;
        const entry = ensureActive();
        if (!entry.nodesBefore.has(id)) entry.nodesBefore.set(id, before);
        entry.nodesAfter.set(id, after);
        changed = true;
      }
      for (const id of edgeIds) {
        const before = cloneEdge(previousEdges.get(id));
        const after = cloneEdge(currentEdges.get(id));
        if (edgeFingerprint(before) === edgeFingerprint(after)) continue;
        const entry = ensureActive();
        if (!entry.edgesBefore.has(id)) entry.edgesBefore.set(id, before);
        entry.edgesAfter.set(id, after);
        changed = true;
      }

      if (changed && !explicitTransaction.current) {
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(commit, IMPLICIT_TRANSACTION_MS);
      }
    });

    return () => {
      unsubscribe();
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      active.current = null;
      commitRef.current = () => undefined;
    };
  }, [projectId]);

  const undo = useCallback(() => {
    commitRef.current();
    const entry = past.current.pop();
    if (!entry) return;
    future.current.push(entry);
    isRestoring.current = true;
    const patch: CanvasHistoryPatch = {
      nodes: entry.nodesBefore,
      edges: entry.edgesBefore,
    };
    useCanvasStore.getState().applyHistoryPatch(patch);
    isRestoring.current = false;
  }, []);

  const redo = useCallback(() => {
    commitRef.current();
    const entry = future.current.pop();
    if (!entry) return;
    past.current.push(entry);
    if (past.current.length > MAX_HISTORY) past.current.shift();
    isRestoring.current = true;
    useCanvasStore.getState().applyHistoryPatch({
      nodes: entry.nodesAfter,
      edges: entry.edgesAfter,
    });
    isRestoring.current = false;
  }, []);

  return { undo, redo };
}
