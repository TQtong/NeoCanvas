'use client';

/**
 * 画布撤销 / 重做（第 01 篇第六节）。
 *
 * 以节点 / 边快照构建历史栈：交互结束后（防抖）记录当前图为一帧；撤销 / 重做在帧间
 * 切换并经状态库的 restoreGraph 落回，差异自动标记脏 / 删除集以持久化。快照在拖动 /
 * 缩放进行中不记录，避免每帧入栈。
 *
 * @module components/canvas/use-canvas-history
 */

import { useCallback, useEffect, useRef } from 'react';
import { useCanvasStore } from '@/stores/canvas-store';
import type { CanvasFlowEdge, CanvasFlowNode } from '@/lib/canvas/node-mapper';

/** 历史栈最大深度。 */
const MAX_HISTORY = 60;

/** 一帧图快照。 */
interface Snapshot {
  nodes: CanvasFlowNode[];
  edges: CanvasFlowEdge[];
}

/** useCanvasHistory 返回值。 */
export interface UseCanvasHistory {
  undo: () => void;
  redo: () => void;
}

/** 浅克隆节点 / 边（含 data 浅拷贝），用于快照隔离。 */
function cloneSnapshot(nodes: CanvasFlowNode[], edges: CanvasFlowEdge[]): Snapshot {
  return {
    nodes: nodes.map((n) => ({ ...n, data: { ...n.data }, position: { ...n.position } })),
    edges: edges.map((e) => ({ ...e })),
  };
}

/**
 * 撤销 / 重做钩子。
 *
 * @param projectId - 当前项目（切换项目时清空历史）
 * @returns undo / redo 动作
 */
export function useCanvasHistory(projectId: string): UseCanvasHistory {
  const past = useRef<Snapshot[]>([]);
  const future = useRef<Snapshot[]>([]);
  const isRestoring = useRef(false);
  const lastSignature = useRef<string>('');

  // 切项目清空历史
  useEffect(() => {
    past.current = [];
    future.current = [];
    lastSignature.current = '';
  }, [projectId]);

  // 监听图结构变化，防抖记录快照
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;

    const unsubscribe = useCanvasStore.subscribe((state, prev) => {
      if (isRestoring.current) return;
      if (state.nodes === prev.nodes && state.edges === prev.edges) return;
      // 以节点 id+位置+尺寸的轻量签名判断是否实质变化
      const signature = state.nodes
        .map((n) => `${n.id}:${Math.round(n.position.x)},${Math.round(n.position.y)},${n.width},${n.height},${n.zIndex}`)
        .join('|');
      if (signature === lastSignature.current) return;
      // 先把变化前的状态入栈
      const prevSnapshot = cloneSnapshot(prev.nodes, prev.edges);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        // 用变化前快照作为可回退帧
        past.current.push(prevSnapshot);
        if (past.current.length > MAX_HISTORY) past.current.shift();
        future.current = [];
        lastSignature.current = signature;
      }, 400);
    });

    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, []);

  const undo = useCallback(() => {
    const snapshot = past.current.pop();
    if (!snapshot) return;
    const { nodes, edges } = useCanvasStore.getState();
    future.current.push(cloneSnapshot(nodes, edges));
    isRestoring.current = true;
    useCanvasStore.getState().restoreGraph(snapshot.nodes, snapshot.edges);
    isRestoring.current = false;
  }, []);

  const redo = useCallback(() => {
    const snapshot = future.current.pop();
    if (!snapshot) return;
    const { nodes, edges } = useCanvasStore.getState();
    past.current.push(cloneSnapshot(nodes, edges));
    isRestoring.current = true;
    useCanvasStore.getState().restoreGraph(snapshot.nodes, snapshot.edges);
    isRestoring.current = false;
  }, []);

  return { undo, redo };
}
