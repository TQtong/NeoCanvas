'use client';

/**
 * 画布媒体签名 URL 解析与续签。
 *
 * 仅在媒体资产引用集合变化时扫描节点；节点位置、选择或尺寸变化不会触发资产查询。每个 asset
 * id 采用 single-flight 解析，并在 URL 到期前五分钟续签。页面休眠恢复和媒体 401/403 加载失败
 * 可立即请求续签，所有引用同一资产的节点一次更新。
 *
 * @module lib/hooks/use-canvas-media
 */

import { useCallback, useEffect, useRef } from 'react';
import type { AssetRow } from '@/types';
import { getBrowserSupabase } from '@/lib/supabase/client';
import { useCanvasStore } from '@/stores/canvas-store';
import { resolveAssetViews } from '@/lib/storage/signed-url';

/** 到期前提前续签的窗口。 */
const RENEW_BEFORE_MS = 5 * 60 * 1_000;
/** 解析失败后的重试间隔。 */
const MEDIA_RETRY_MS = 30_000;
/** 浏览器 setTimeout 的安全上限。 */
const MAX_TIMER_MS = 2_147_000_000;
const ASSET_REFRESH_EVENT = 'neocanvas:refresh-asset';

/** 媒体节点加载失败时请求工作台续签指定资产。 */
export function requestCanvasAssetRefresh(assetId: string): void {
  if (typeof window === 'undefined' || !assetId) return;
  window.dispatchEvent(new CustomEvent<string>(ASSET_REFRESH_EVENT, { detail: assetId }));
}

/** 收集当前画布引用的唯一 asset id。 */
function currentAssetIds(): string[] {
  const ids = new Set<string>();
  for (const node of useCanvasStore.getState().nodes) {
    if ((node.data.type === 'image' || node.data.type === 'video') && node.data.assetId) {
      ids.add(node.data.assetId);
    }
  }
  return Array.from(ids);
}

/**
 * 在设计页挂载媒体解析与续签。
 *
 * @param projectId - 当前项目
 */
export function useCanvasMedia(projectId: string): void {
  const mediaRevision = useCanvasStore((state) => state._mediaRevision);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const inFlightRef = useRef<Map<string, Promise<void>>>(new Map());
  const projectRef = useRef(projectId);

  const clearAssetTimer = useCallback((assetId: string): void => {
    const timer = timersRef.current.get(assetId);
    if (timer) clearTimeout(timer);
    timersRef.current.delete(assetId);
  }, []);

  const resolveAssets = useCallback(async (requestedIds: string[]): Promise<void> => {
    const assetIds = Array.from(new Set(requestedIds.filter(Boolean)));
    if (assetIds.length === 0) return;

    const existingPromises = assetIds
      .map((assetId) => inFlightRef.current.get(assetId))
      .filter((promise): promise is Promise<void> => Boolean(promise));
    const freshIds = assetIds.filter((assetId) => !inFlightRef.current.has(assetId));

    if (freshIds.length > 0) {
      const activeProject = projectRef.current;
      const task = (async () => {
        const supabase = getBrowserSupabase();
        const { data, error } = await supabase
          .from('assets')
          .select('*')
          .eq('project_id', activeProject)
          .in('id', freshIds);
        if (error) throw error;
        const rows = (data ?? []) as AssetRow[];
        const views = await resolveAssetViews(supabase, rows);
        if (projectRef.current !== activeProject) return;

        const viewsById = new Map(views.map((view) => [view.id, view]));
        for (const assetId of freshIds) {
          const view = viewsById.get(assetId);
          if (!view?.url) throw new Error(`无法解析画布资产：${assetId}`);
          useCanvasStore.getState().setAssetRuntime(assetId, {
            src: view.url,
            thumbnailSrc: view.thumbnailUrl,
            posterSrc: view.thumbnailUrl,
            urlExpiresAt: view.expiresAt,
          });
        }
      })();
      for (const assetId of freshIds) inFlightRef.current.set(assetId, task);
      const clearInFlight = (): void => {
        for (const assetId of freshIds) {
          if (inFlightRef.current.get(assetId) === task) inFlightRef.current.delete(assetId);
        }
      };
      void task.then(clearInFlight, clearInFlight);
      existingPromises.push(task);
    }

    await Promise.all(existingPromises);
  }, []);

  /** 根据当前缓存为一组资产续签或安排到期 timer。 */
  const ensureAssets = useCallback(
    async (assetIds: string[], force = false): Promise<void> => {
      const uniqueIds = Array.from(new Set(assetIds));
      const referenced = new Set(currentAssetIds());
      for (const [assetId] of timersRef.current) {
        if (!referenced.has(assetId)) clearAssetTimer(assetId);
      }

      const now = Date.now();
      const renewIds: string[] = [];
      const state = useCanvasStore.getState();
      for (const assetId of uniqueIds) {
        if (!referenced.has(assetId)) continue;
        const runtime = state._assetRuntime[assetId];
        const expiresAt = runtime?.urlExpiresAt
          ? new Date(runtime.urlExpiresAt).getTime()
          : Number.NaN;
        if (
          force ||
          !runtime?.src ||
          !Number.isFinite(expiresAt) ||
          expiresAt <= now + RENEW_BEFORE_MS
        ) {
          clearAssetTimer(assetId);
          renewIds.push(assetId);
          continue;
        }

        clearAssetTimer(assetId);
        const delay = Math.min(MAX_TIMER_MS, Math.max(1_000, expiresAt - now - RENEW_BEFORE_MS));
        timersRef.current.set(
          assetId,
          setTimeout(() => {
            clearAssetTimer(assetId);
            void ensureAssets([assetId], true);
          }, delay),
        );
      }

      if (renewIds.length === 0) return;
      try {
        await resolveAssets(renewIds);
        const refreshedState = useCanvasStore.getState();
        for (const assetId of renewIds) {
          const expiresAt = refreshedState._assetRuntime[assetId]?.urlExpiresAt;
          const expiresMs = expiresAt ? new Date(expiresAt).getTime() : Number.NaN;
          clearAssetTimer(assetId);
          const delay = Number.isFinite(expiresMs)
            ? Math.min(MAX_TIMER_MS, Math.max(1_000, expiresMs - Date.now() - RENEW_BEFORE_MS))
            : MEDIA_RETRY_MS;
          timersRef.current.set(
            assetId,
            setTimeout(() => {
              clearAssetTimer(assetId);
              void ensureAssets([assetId], true);
            }, delay),
          );
        }
      } catch {
        for (const assetId of renewIds) {
          clearAssetTimer(assetId);
          timersRef.current.set(
            assetId,
            setTimeout(() => {
              clearAssetTimer(assetId);
              void ensureAssets([assetId], true);
            }, MEDIA_RETRY_MS),
          );
        }
      }
    },
    [clearAssetTimer, resolveAssets],
  );

  useEffect(() => {
    projectRef.current = projectId;
    for (const timer of timersRef.current.values()) clearTimeout(timer);
    timersRef.current.clear();
    inFlightRef.current.clear();
  }, [projectId]);

  useEffect(() => {
    void ensureAssets(currentAssetIds());
  }, [ensureAssets, mediaRevision, projectId]);

  useEffect(() => {
    const handleRefresh = (event: Event): void => {
      const assetId = (event as CustomEvent<string>).detail;
      if (assetId) void ensureAssets([assetId], true);
    };
    const handleVisibility = (): void => {
      if (document.visibilityState === 'visible') void ensureAssets(currentAssetIds());
    };
    window.addEventListener(ASSET_REFRESH_EVENT, handleRefresh);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.removeEventListener(ASSET_REFRESH_EVENT, handleRefresh);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [ensureAssets]);

  useEffect(
    () => () => {
      for (const timer of timersRef.current.values()) clearTimeout(timer);
      timersRef.current.clear();
      inFlightRef.current.clear();
    },
    [],
  );
}
