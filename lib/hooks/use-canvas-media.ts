'use client';

/**
 * 画布媒体解析钩子。
 *
 * 节点查询只携带 asset_id，真实媒体经 Storage 签名 URL 另行加载（第 06 篇第三节）。
 * 本钩子收集画布上 image / video 节点未解析的资产，批量取资产行并创建签名 URL，把
 * `src` / `thumbnailSrc` / `posterSrc` 作为运行时字段注入节点 data（不标记脏集）。
 *
 * @module lib/hooks/use-canvas-media
 */

import { useEffect, useRef } from 'react';
import type { AssetRow } from '@/types';
import { getBrowserSupabase } from '@/lib/supabase/client';
import { useCanvasStore } from '@/stores/canvas-store';
import { resolveAssetView } from '@/lib/storage/signed-url';

/**
 * 在设计页挂载媒体解析。监听节点集合变化，为新出现且未解析的图片 / 视频节点注入 URL。
 *
 * @param projectId - 当前项目（用于触发重置）
 */
export function useCanvasMedia(projectId: string): void {
  // 已解析过的 assetId 缓存，避免重复请求
  const resolved = useRef<Set<string>>(new Set());

  useEffect(() => {
    resolved.current = new Set();
  }, [projectId]);

  useEffect(() => {
    const supabase = getBrowserSupabase();

    /** 解析当前缺失 src 的媒体节点。 */
    const resolvePending = async (): Promise<void> => {
      const state = useCanvasStore.getState();
      // 收集需要解析的 (nodeId, assetId)
      const pending: Array<{ nodeId: string; assetId: string }> = [];
      for (const node of state.nodes) {
        if (node.data.type === 'image' || node.data.type === 'video') {
          const assetId = node.data.assetId;
          if (assetId && !node.data.src && !resolved.current.has(`${node.id}:${assetId}`)) {
            pending.push({ nodeId: node.id, assetId });
          }
        }
      }
      if (pending.length === 0) return;

      const uniqueAssetIds = Array.from(new Set(pending.map((p) => p.assetId)));
      const { data: rows } = await supabase.from('assets').select('*').in('id', uniqueAssetIds);
      const byId = new Map<string, AssetRow>((rows ?? []).map((r) => [r.id, r]));

      for (const { nodeId, assetId } of pending) {
        const row = byId.get(assetId);
        resolved.current.add(`${nodeId}:${assetId}`);
        if (!row) continue;
        const view = await resolveAssetView(supabase, row);
        useCanvasStore.getState().setNodeRuntime(nodeId, {
          src: view.url,
          thumbnailSrc: view.thumbnailUrl,
        });
      }
    };

    // 立即解析一次，并在节点集合变化时再解析
    void resolvePending();
    const unsubscribe = useCanvasStore.subscribe((state, prev) => {
      if (state.nodes !== prev.nodes) {
        void resolvePending();
      }
    });

    return unsubscribe;
  }, [projectId]);
}
