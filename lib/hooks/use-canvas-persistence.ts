'use client';

/**
 * 画布持久化控制器（第 04 篇第三、五节）。
 *
 * 订阅画布状态库的脏集，在防抖窗口到期后把节点 / 边的本地变更按节点粒度写回 PostgREST
 * （upsert / delete），并把视口防抖写回 projects。写回成功后记录服务端版本以支持回声
 * 抑制。高频交互中间态只在本地反映、不写库，避免写入风暴。
 *
 * @module lib/hooks/use-canvas-persistence
 */

import { useEffect } from 'react';
import { getBrowserSupabase } from '@/lib/supabase/client';
import { useCanvasStore } from '@/stores/canvas-store';
import { edgeToInsert, nodeToInsert } from '@/lib/canvas/node-mapper';
import { debounce } from '@/lib/utils/debounce';

/** 节点 / 边写回防抖窗口（毫秒）。 */
const PERSIST_DEBOUNCE_MS = 600;
/** 视口写回防抖窗口（毫秒）。 */
const VIEWPORT_DEBOUNCE_MS = 800;

/**
 * 在设计页挂载持久化控制器。
 *
 * @param projectId - 当前项目
 * @param userId - 当前用户（作为新节点 created_by）
 * @param onError - 写回失败回调（用于提示）
 */
export function useCanvasPersistence(
  projectId: string,
  userId: string,
  onError?: (message: string) => void,
): void {
  useEffect(() => {
    const supabase = getBrowserSupabase();
    const store = useCanvasStore;

    const flushDirty = debounce(() => {
      void (async () => {
        const { upserts, deletes, edgeUpserts, edgeDeletes } = store.getState().flushDirty();
        try {
          if (upserts.length > 0) {
            const rows = upserts.map((node) => nodeToInsert(node, projectId, userId));
            const { data, error } = await supabase
              .from('canvas_nodes')
              .upsert(rows, { onConflict: 'id' })
              .select('id, updated_at');
            if (error) throw error;
            for (const r of data ?? []) {
              store.getState().markNodePersisted(r.id, r.updated_at);
            }
          }
          if (deletes.length > 0) {
            const { error } = await supabase.from('canvas_nodes').delete().in('id', deletes);
            if (error) throw error;
          }
          if (edgeUpserts.length > 0) {
            const rows = edgeUpserts.map((edge) => edgeToInsert(edge, projectId));
            const { error } = await supabase.from('canvas_edges').upsert(rows, { onConflict: 'id' });
            if (error) throw error;
          }
          if (edgeDeletes.length > 0) {
            const { error } = await supabase.from('canvas_edges').delete().in('id', edgeDeletes);
            if (error) throw error;
          }
        } catch (err) {
          // 清除本批节点的在途标记，使后续真正的远端变更不被回声抑制误挡
          store.getState().markPersistFailed(upserts.map((node) => node.id));
          // eslint-disable-next-line no-console
          console.error('画布持久化失败', err);
          onError?.(err instanceof Error ? err.message : '画布保存失败');
        }
      })();
    }, PERSIST_DEBOUNCE_MS);

    const flushViewport = debounce(() => {
      void (async () => {
        if (!store.getState().flushViewportDirty()) return;
        const { viewport } = store.getState();
        const { error } = await supabase.from('projects').update({ viewport }).eq('id', projectId);
        if (error) {
          // eslint-disable-next-line no-console
          console.error('视口持久化失败', error);
        }
      })();
    }, VIEWPORT_DEBOUNCE_MS);

    const unsubscribe = store.subscribe((state) => {
      if (
        state._dirtyNodeIds.size > 0 ||
        state._deletedNodeIds.size > 0 ||
        state._dirtyEdgeIds.size > 0 ||
        state._deletedEdgeIds.size > 0
      ) {
        flushDirty();
      }
      if (state._viewportDirty) {
        flushViewport();
      }
    });

    return () => {
      unsubscribe();
      // 卸载前尽力刷出挂起的写回
      flushDirty.flush();
      flushViewport.flush();
    };
  }, [projectId, userId, onError]);
}
