'use client';

/**
 * 画布串行持久化与离线恢复控制器。
 *
 * Zustand 负责即时投影，IndexedDB outbox 负责跨刷新保存未确认 mutation，PostgREST 负责按实体
 * 批量提交。每个项目任意时刻只有一个网络批次；批次期间产生的新 revision 保留在 dirty/outbox
 * 中，由下一轮提交，旧响应只能确认自己捕获的 revision。
 *
 * @module lib/hooks/use-canvas-persistence
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CanvasEdgeRow, CanvasNodeRow, SyncState, Viewport } from '@/types';
import { getBrowserSupabase } from '@/lib/supabase/client';
import { useCanvasStore } from '@/stores/canvas-store';
import {
  edgeToInsert,
  nodeToInsert,
  rowToEdge,
  rowToNode,
  type CanvasFlowEdge,
  type CanvasFlowNode,
} from '@/lib/canvas/node-mapper';
import {
  countProjectOutbox,
  deleteConfirmedOutboxEntry,
  listProjectOutbox,
  OutboxUnavailableError,
  putOutboxEntry,
  type OutboxEntity,
  type OutboxEntry,
  type OutboxOperation,
} from '@/lib/canvas/outbox';
import { debounce } from '@/lib/utils/debounce';

/** 节点 / 边写回防抖窗口（毫秒）。 */
const PERSIST_DEBOUNCE_MS = 600;
/** 视口写回防抖窗口（毫秒）。 */
const VIEWPORT_DEBOUNCE_MS = 800;
/** 暂时错误的退避序列。 */
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const;
const VIEWPORT_ENTITY_ID = 'project-viewport';

/** useCanvasPersistence 返回的控制动作。 */
export interface CanvasPersistenceController {
  /** outbox 已完成打开与重放，可以安全接受画布编辑。 */
  ready: boolean;
  /** 立即重试当前项目全部未确认 mutation。 */
  retryPending: () => void;
}

interface StagedMutation {
  operation: OutboxOperation;
  source: unknown;
  revision: number;
  createdAt: string;
}

interface PersistFailure {
  message: string;
  retryable: boolean;
}

let lastRevision = Date.now() * 1_000;

/** 生成全页面单调递增且在 Number 安全整数范围内的客户端 revision。 */
function nextClientRevision(): number {
  lastRevision = Math.max(lastRevision + 1, Date.now() * 1_000);
  return lastRevision;
}

/** outbox map 使用的稳定实体键。 */
function mutationKey(entity: OutboxEntity, entityId: string): string {
  return `${entity}:${entityId}`;
}

/** 当前 Store 的待同步实体数估计，IndexedDB 不可用时仍可给用户准确反馈。 */
function pendingCountFromStore(): number {
  const state = useCanvasStore.getState();
  return new Set([
    ...Array.from(state._dirtyNodeIds, (id) => `node:${id}`),
    ...Array.from(state._deletedNodeIds, (id) => `node:${id}`),
    ...Array.from(state._pendingNodeIds, (id) => `node:${id}`),
    ...Array.from(state._dirtyEdgeIds, (id) => `edge:${id}`),
    ...Array.from(state._deletedEdgeIds, (id) => `edge:${id}`),
    ...Array.from(state._pendingEdgeIds, (id) => `edge:${id}`),
    ...(state._viewportDirty ? [`viewport:${VIEWPORT_ENTITY_ID}`] : []),
  ]).size;
}

/** 归一化持久化错误，并区分暂时错误与永久校验/权限错误。 */
function classifyPersistenceError(error: unknown): PersistFailure {
  if (error instanceof OutboxUnavailableError) {
    return { message: error.message, retryable: false };
  }
  const value = error as { message?: unknown; code?: unknown; status?: unknown } | null;
  const message = typeof value?.message === 'string' ? value.message : '画布保存失败';
  const code = typeof value?.code === 'string' ? value.code : '';
  const status = typeof value?.status === 'number' ? value.status : null;
  if (status === 408 || status === 429 || (status !== null && status >= 500)) {
    return { message, retryable: true };
  }
  if (status !== null && status >= 400 && status < 500) {
    return { message, retryable: false };
  }
  if (/^(22|23|28|42)/.test(code) || code === 'PGRST116' || code === 'PGRST301') {
    return { message, retryable: false };
  }
  return { message, retryable: true };
}

/** 等待父级工作台完成 CanvasStore 水合，避免 child effect 抢先恢复到空 Store。 */
function waitForCanvasHydration(projectId: string): Promise<void> {
  if (useCanvasStore.getState().projectId === projectId) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      unsubscribe();
      reject(new Error('等待画布初始化超时'));
    }, 10_000);
    const unsubscribe = useCanvasStore.subscribe((state) => {
      if (state.projectId !== projectId) return;
      window.clearTimeout(timeout);
      unsubscribe();
      resolve();
    });
  });
}

/** 校验并把 outbox 节点 payload 还原为本地节点。 */
function decodeNodeEntry(entry: OutboxEntry): CanvasFlowNode {
  const payload = entry.payload as Partial<CanvasNodeRow> | null;
  if (
    !payload ||
    payload.id !== entry.entityId ||
    payload.project_id !== entry.projectId ||
    !payload.type ||
    typeof payload.position_x !== 'number' ||
    typeof payload.position_y !== 'number' ||
    !payload.created_by
  ) {
    throw new Error(`离线节点记录损坏：${entry.entityId}`);
  }
  return rowToNode({
    ...(payload as CanvasNodeRow),
    width: payload.width ?? null,
    height: payload.height ?? null,
    rotation: payload.rotation ?? 0,
    z_index: Math.max(0, payload.z_index ?? 0),
    parent_id: payload.parent_id ?? null,
    data: payload.data ?? {},
    asset_id: payload.asset_id ?? null,
    generation_id: payload.generation_id ?? null,
    created_at: payload.created_at ?? entry.createdAt,
    updated_at: payload.updated_at ?? entry.updatedAt,
  });
}

/** 校验并把 outbox 边 payload 还原为本地边。 */
function decodeEdgeEntry(entry: OutboxEntry): CanvasFlowEdge {
  const payload = entry.payload as Partial<CanvasEdgeRow> | null;
  if (
    !payload ||
    payload.id !== entry.entityId ||
    payload.project_id !== entry.projectId ||
    !payload.source_node_id ||
    !payload.target_node_id
  ) {
    throw new Error(`离线连线记录损坏：${entry.entityId}`);
  }
  return rowToEdge({
    ...(payload as CanvasEdgeRow),
    source_handle: payload.source_handle ?? null,
    target_handle: payload.target_handle ?? null,
    type: payload.type ?? 'default',
    data: payload.data ?? {},
    created_at: payload.created_at ?? entry.createdAt,
  });
}

/** 校验 outbox 视口。 */
function decodeViewportEntry(entry: OutboxEntry): Viewport {
  const payload = entry.payload as Partial<Viewport> | null;
  if (
    !payload ||
    typeof payload.x !== 'number' ||
    typeof payload.y !== 'number' ||
    typeof payload.zoom !== 'number'
  ) {
    throw new Error('离线视口记录损坏');
  }
  return { x: payload.x, y: payload.y, zoom: payload.zoom };
}

/**
 * 在设计页挂载持久化控制器。
 *
 * @param projectId - 当前项目
 * @param userId - 当前用户（作为新节点 created_by）
 * @param onError - 写回失败回调
 * @returns 手动重试控制器
 */
export function useCanvasPersistence(
  projectId: string,
  userId: string,
  onError?: (message: string) => void,
): CanvasPersistenceController {
  const onErrorRef = useRef(onError);
  const retryRef = useRef<() => void>(() => undefined);
  const [ready, setReady] = useState(false);
  onErrorRef.current = onError;

  useEffect(() => {
    setReady(false);
    const supabase = getBrowserSupabase();
    const store = useCanvasStore;
    const staged = new Map<string, StagedMutation>();
    let disposed = false;
    let replaying = true;
    let outboxAvailable = true;
    let stageChain: Promise<void> = Promise.resolve();
    let running = false;
    let flushRequested = false;
    let retryAttempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let lastReportedError = '';

    const setSyncState = (syncState: SyncState): void => {
      if (!disposed) store.getState().setSyncState(syncState);
    };

    /** 当前 source 发生变化时，先把最新完整 payload 写入 IndexedDB。 */
    const stageMutation = (
      entity: OutboxEntity,
      entityId: string,
      operation: OutboxOperation,
      source: unknown,
      payload: unknown,
    ): Promise<void> | null => {
      const key = mutationKey(entity, entityId);
      const previous = staged.get(key);
      if (previous?.operation === operation && previous.source === source) return null;
      const now = new Date().toISOString();
      const mutation: StagedMutation = {
        operation,
        source,
        revision: nextClientRevision(),
        createdAt: previous?.createdAt ?? now,
      };
      staged.set(key, mutation);
      return putOutboxEntry({
        projectId,
        entity,
        entityId,
        operation,
        payload,
        clientRevision: mutation.revision,
        createdAt: mutation.createdAt,
        updatedAt: now,
      });
    };

    /** 扫描脏集合，把每个实体的最后状态立即写入 outbox。 */
    const stageDirtyState = async (): Promise<void> => {
      if (disposed || replaying) return;
      const state = store.getState();
      if (state.projectId !== projectId) return;
      const nodeById = new Map(state.nodes.map((node) => [node.id, node]));
      const edgeById = new Map(state.edges.map((edge) => [edge.id, edge]));
      const writes: Promise<void>[] = [];

      for (const id of state._deletedNodeIds) {
        const write = stageMutation('node', id, 'delete', 'delete', null);
        if (write) writes.push(write);
      }
      for (const id of state._dirtyNodeIds) {
        if (state._deletedNodeIds.has(id)) continue;
        const node = nodeById.get(id);
        if (!node) continue;
        const write = stageMutation(
          'node',
          id,
          'upsert',
          node,
          nodeToInsert(node, projectId, userId),
        );
        if (write) writes.push(write);
      }

      for (const id of state._deletedEdgeIds) {
        const write = stageMutation('edge', id, 'delete', 'delete', null);
        if (write) writes.push(write);
      }
      for (const id of state._dirtyEdgeIds) {
        if (state._deletedEdgeIds.has(id)) continue;
        const edge = edgeById.get(id);
        if (!edge) continue;
        const write = stageMutation('edge', id, 'upsert', edge, edgeToInsert(edge, projectId));
        if (write) writes.push(write);
      }

      if (state._viewportDirty) {
        const source = `${state.viewport.x}:${state.viewport.y}:${state.viewport.zoom}`;
        const write = stageMutation(
          'viewport',
          VIEWPORT_ENTITY_ID,
          'upsert',
          source,
          state.viewport,
        );
        if (write) writes.push(write);
      }

      if (writes.length === 0) return;
      setSyncState({ status: 'saving', pendingCount: pendingCountFromStore() });
      try {
        await Promise.all(writes);
      } catch (error) {
        outboxAvailable = false;
        const failure = classifyPersistenceError(error);
        setSyncState({
          status: 'error',
          pendingCount: pendingCountFromStore(),
          message: failure.message,
          retryable: false,
        });
        if (lastReportedError !== failure.message) {
          lastReportedError = failure.message;
          onErrorRef.current?.(failure.message);
        }
      }
    };

    /** 捕获一个实体对应的当前 revision；outbox 不可用时仍生成请求确认边界。 */
    const revisionFor = (entity: OutboxEntity, entityId: string): number => {
      const mutation = staged.get(mutationKey(entity, entityId));
      return mutation?.revision ?? nextClientRevision();
    };

    /** 服务端确认后只删除不晚于本批的 outbox 记录。 */
    const confirm = async (
      entity: OutboxEntity,
      entityId: string,
      revision: number,
    ): Promise<void> => {
      if (!outboxAvailable) return;
      await deleteConfirmedOutboxEntry(projectId, entity, entityId, revision);
    };

    /** 提交一个不可变批次；各实体类别独立确认，失败项保留以重试。 */
    const persistOneBatch = async (): Promise<PersistFailure | null> => {
      await stageChain;
      const { upserts, deletes, edgeUpserts, edgeDeletes } = store.getState().flushDirty();
      const viewportDirty = store.getState().flushViewportDirty();
      if (
        upserts.length === 0 &&
        deletes.length === 0 &&
        edgeUpserts.length === 0 &&
        edgeDeletes.length === 0 &&
        !viewportDirty
      ) {
        return null;
      }

      const pendingCount = outboxAvailable
        ? await countProjectOutbox(projectId).catch(() => pendingCountFromStore())
        : pendingCountFromStore();
      setSyncState({ status: 'saving', pendingCount: Math.max(1, pendingCount) });
      let firstFailure: PersistFailure | null = null;
      let nodeUpsertsSucceeded = true;

      if (upserts.length > 0) {
        const revisions = new Map(upserts.map((node) => [node.id, revisionFor('node', node.id)]));
        try {
          const rows = upserts.map((node) => nodeToInsert(node, projectId, userId));
          const { data, error } = await supabase
            .from('canvas_nodes')
            .upsert(rows, { onConflict: 'id' })
            .select('id, updated_at');
          if (error) throw error;
          const versionById = new Map((data ?? []).map((row) => [row.id, row.updated_at]));
          for (const node of upserts) {
            store
              .getState()
              .markNodePersisted(node.id, versionById.get(node.id) ?? new Date().toISOString());
            await confirm('node', node.id, revisions.get(node.id) ?? 0);
          }
        } catch (error) {
          nodeUpsertsSucceeded = false;
          store.getState().markPersistFailed(upserts.map((node) => node.id));
          firstFailure = classifyPersistenceError(error);
        }
      }

      if (edgeUpserts.length > 0) {
        const revisions = new Map(
          edgeUpserts.map((edge) => [edge.id, revisionFor('edge', edge.id)]),
        );
        if (!nodeUpsertsSucceeded) {
          store.getState().markEdgesPersistFailed(edgeUpserts.map((edge) => edge.id));
        } else {
          try {
            const rows = edgeUpserts.map((edge) => edgeToInsert(edge, projectId));
            const { error } = await supabase
              .from('canvas_edges')
              .upsert(rows, { onConflict: 'id' });
            if (error) throw error;
            store.getState().markEdgesPersisted(edgeUpserts.map((edge) => edge.id));
            for (const edge of edgeUpserts) {
              await confirm('edge', edge.id, revisions.get(edge.id) ?? 0);
            }
          } catch (error) {
            store.getState().markEdgesPersistFailed(edgeUpserts.map((edge) => edge.id));
            firstFailure ??= classifyPersistenceError(error);
          }
        }
      }

      if (edgeDeletes.length > 0) {
        const revisions = new Map(edgeDeletes.map((id) => [id, revisionFor('edge', id)]));
        try {
          const { error } = await supabase.from('canvas_edges').delete().in('id', edgeDeletes);
          if (error) throw error;
          for (const id of edgeDeletes) await confirm('edge', id, revisions.get(id) ?? 0);
        } catch (error) {
          store.getState().markEdgesPersistFailed([], edgeDeletes);
          firstFailure ??= classifyPersistenceError(error);
        }
      }

      if (deletes.length > 0) {
        const revisions = new Map(deletes.map((id) => [id, revisionFor('node', id)]));
        try {
          const { error } = await supabase.from('canvas_nodes').delete().in('id', deletes);
          if (error) throw error;
          for (const id of deletes) await confirm('node', id, revisions.get(id) ?? 0);
        } catch (error) {
          store.getState().markPersistFailed([], deletes);
          firstFailure ??= classifyPersistenceError(error);
        }
      }

      if (viewportDirty) {
        const revision = revisionFor('viewport', VIEWPORT_ENTITY_ID);
        try {
          const { viewport } = store.getState();
          const { error } = await supabase
            .from('projects')
            .update({ viewport })
            .eq('id', projectId);
          if (error) throw error;
          await confirm('viewport', VIEWPORT_ENTITY_ID, revision);
        } catch (error) {
          store.getState().markViewportPersistFailed();
          firstFailure ??= classifyPersistenceError(error);
        }
      }

      return firstFailure;
    };

    /** 串行消费所有已就绪批次；失败时退出循环并交给退避/人工重试。 */
    const runFlushLoop = async (): Promise<void> => {
      if (disposed) return;
      if (running) {
        flushRequested = true;
        return;
      }
      if (retryTimer) return;
      running = true;
      let failure: PersistFailure | null = null;
      try {
        do {
          flushRequested = false;
          failure = await persistOneBatch();
          if (failure) break;
          const state = store.getState();
          flushRequested =
            flushRequested ||
            state._dirtyNodeIds.size > 0 ||
            state._deletedNodeIds.size > 0 ||
            state._dirtyEdgeIds.size > 0 ||
            state._deletedEdgeIds.size > 0 ||
            state._viewportDirty;
        } while (flushRequested && !disposed);
      } finally {
        running = false;
      }

      if (disposed) return;
      if (failure) {
        const count = outboxAvailable
          ? await countProjectOutbox(projectId).catch(() => pendingCountFromStore())
          : pendingCountFromStore();
        if (!navigator.onLine) {
          setSyncState({ status: 'offline', pendingCount: count });
        } else {
          setSyncState({
            status: 'error',
            pendingCount: count,
            message: failure.message,
            retryable: failure.retryable,
          });
        }
        if (lastReportedError !== failure.message) {
          lastReportedError = failure.message;
          onErrorRef.current?.(failure.message);
        }
        if (failure.retryable && navigator.onLine) {
          const delay = RETRY_DELAYS_MS[Math.min(retryAttempt, RETRY_DELAYS_MS.length - 1)];
          retryAttempt += 1;
          retryTimer = setTimeout(() => {
            retryTimer = null;
            requestFlush(true);
          }, delay);
        }
        return;
      }

      retryAttempt = 0;
      lastReportedError = '';
      const remaining = outboxAvailable
        ? await countProjectOutbox(projectId).catch(() => pendingCountFromStore())
        : pendingCountFromStore();
      if (remaining === 0 && outboxAvailable) {
        setSyncState({ status: 'saved', confirmedAt: new Date().toISOString() });
      } else if (remaining > 0) {
        setSyncState({ status: 'saving', pendingCount: remaining });
        requestFlush(true);
      } else {
        setSyncState({
          status: 'error',
          pendingCount: 0,
          message: '编辑已写入服务器，但当前浏览器无法提供离线恢复保护',
          retryable: false,
        });
      }
    };

    const debouncedFlush = debounce(() => void runFlushLoop(), PERSIST_DEBOUNCE_MS);
    const debouncedViewportFlush = debounce(() => void runFlushLoop(), VIEWPORT_DEBOUNCE_MS);
    function requestFlush(immediate = false): void {
      if (disposed || retryTimer) return;
      if (immediate) {
        debouncedFlush.cancel();
        debouncedViewportFlush.cancel();
        void runFlushLoop();
      } else {
        debouncedFlush();
      }
    }

    /** Store 任意 mutation 先串入 stageChain，再按实体/视口防抖触发网络提交。 */
    const unsubscribeStore = store.subscribe((state) => {
      if (replaying || state.projectId !== projectId) return;
      const hasEntityChanges =
        state._dirtyNodeIds.size > 0 ||
        state._deletedNodeIds.size > 0 ||
        state._dirtyEdgeIds.size > 0 ||
        state._deletedEdgeIds.size > 0;
      if (hasEntityChanges || state._viewportDirty) {
        stageChain = stageChain.then(stageDirtyState);
      }
      if (hasEntityChanges) debouncedFlush();
      if (state._viewportDirty) debouncedViewportFlush();
    });

    const handleOffline = (): void => {
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      setSyncState({ status: 'offline', pendingCount: pendingCountFromStore() });
    };
    const handleOnline = (): void => {
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      retryAttempt = 0;
      requestFlush(true);
    };
    const handleBeforeUnload = (event: BeforeUnloadEvent): void => {
      // 只在确有未确认实体时提示。IndexedDB 不可用但服务器已经确认全部写入时会保留错误
      // 状态用于告知“无离线保护”，却不应制造一个永远无法消除的离开页面弹窗。
      if (pendingCountFromStore() === 0) return;
      event.preventDefault();
      event.returnValue = '';
    };
    const handleVisibility = (): void => {
      if (document.visibilityState === 'visible' && navigator.onLine) requestFlush(true);
    };

    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);
    window.addEventListener('beforeunload', handleBeforeUnload);
    document.addEventListener('visibilitychange', handleVisibility);

    retryRef.current = () => {
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      retryAttempt = 0;
      requestFlush(true);
    };

    /** 启动时把 outbox 重放到服务端快照上，再立即恢复提交。 */
    void (async () => {
      try {
        await waitForCanvasHydration(projectId);
        const entries = await listProjectOutbox(projectId);
        if (disposed) return;

        const nodeUpserts: CanvasFlowNode[] = [];
        const nodeDeletes: string[] = [];
        const edgeUpserts: CanvasFlowEdge[] = [];
        const edgeDeletes: string[] = [];
        let viewport: Viewport | undefined;

        for (const entry of entries) {
          lastRevision = Math.max(lastRevision, entry.clientRevision);
          staged.set(mutationKey(entry.entity, entry.entityId), {
            operation: entry.operation,
            source: entry.operation === 'delete' ? 'delete' : entry.payload,
            revision: entry.clientRevision,
            createdAt: entry.createdAt,
          });
          if (entry.entity === 'node') {
            if (entry.operation === 'delete') nodeDeletes.push(entry.entityId);
            else nodeUpserts.push(decodeNodeEntry(entry));
          } else if (entry.entity === 'edge') {
            if (entry.operation === 'delete') edgeDeletes.push(entry.entityId);
            else edgeUpserts.push(decodeEdgeEntry(entry));
          } else if (entry.operation === 'upsert') {
            viewport = decodeViewportEntry(entry);
          }
        }

        if (entries.length > 0) {
          store.getState().replayOutbox({
            nodeUpserts,
            nodeDeletes,
            edgeUpserts,
            edgeDeletes,
            viewport,
          });
          // 重放产生的新对象引用对应既有 revision，避免无意义改写 outbox。
          const state = store.getState();
          for (const node of state.nodes) {
            const key = mutationKey('node', node.id);
            const mutation = staged.get(key);
            if (mutation?.operation === 'upsert') mutation.source = node;
          }
          for (const edge of state.edges) {
            const key = mutationKey('edge', edge.id);
            const mutation = staged.get(key);
            if (mutation?.operation === 'upsert') mutation.source = edge;
          }
          const viewportMutation = staged.get(mutationKey('viewport', VIEWPORT_ENTITY_ID));
          if (viewportMutation) {
            viewportMutation.source = `${state.viewport.x}:${state.viewport.y}:${state.viewport.zoom}`;
          }
        }

        replaying = false;
        stageChain = stageChain.then(stageDirtyState);
        await stageChain;
        if (disposed) return;
        setReady(true);
        if (entries.length > 0) {
          setSyncState({
            status: navigator.onLine ? 'saving' : 'offline',
            pendingCount: entries.length,
          });
          if (navigator.onLine) requestFlush(true);
        } else {
          setSyncState({ status: 'saved', confirmedAt: new Date().toISOString() });
        }
      } catch (error) {
        replaying = false;
        outboxAvailable = false;
        if (!disposed) setReady(true);
        const failure = classifyPersistenceError(error);
        setSyncState({
          status: 'error',
          pendingCount: pendingCountFromStore(),
          message: failure.message,
          retryable: false,
        });
        onErrorRef.current?.(failure.message);
      }
    })();

    return () => {
      // 所有变更已经由同步订阅串入 stageChain；卸载不假定异步网络能完成，outbox 是恢复依据。
      debouncedFlush.cancel();
      debouncedViewportFlush.cancel();
      unsubscribeStore();
      if (retryTimer) clearTimeout(retryTimer);
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('beforeunload', handleBeforeUnload);
      document.removeEventListener('visibilitychange', handleVisibility);
      retryRef.current = () => undefined;
      disposed = true;
    };
  }, [projectId, userId]);

  const retryPending = useCallback(() => retryRef.current(), []);
  return { ready, retryPending };
}
