'use client';

/**
 * 实时订阅装配钩子（第 04 篇第五节）。
 *
 * 设计页挂载后订阅本项目频道，把 `canvas_nodes` / `canvas_edges` / `generations` /
 * `messages` 的行变更分发到画布与对话状态库。占位向真实节点的转化经 canvas_nodes 的
 * 更新事件推达；生成进度经 generations 更新事件驱动占位卡片。
 *
 * @module lib/hooks/use-realtime-project
 */

import { useEffect, useState } from 'react';
import { getBrowserSupabase } from '@/lib/supabase/client';
import { subscribeProject } from '@/lib/realtime/project-channel';
import { useCanvasStore } from '@/stores/canvas-store';

/** 实时连接状态。 */
export type RealtimeStatus = 'connecting' | 'subscribed' | 'closed' | 'error' | 'timed_out';

/**
 * 装配项目实时订阅。
 *
 * @param projectId - 项目标识
 * @returns 当前实时连接状态
 */
export function useRealtimeProject(projectId: string): RealtimeStatus {
  const [status, setStatus] = useState<RealtimeStatus>('connecting');

  useEffect(() => {
    const supabase = getBrowserSupabase();
    let unsubscribe = () => {};
    let cancelled = false;

    void (async () => {
      // 订阅前先把当前会话的用户 JWT 绑定到 Realtime socket，确保频道以 authenticated 身份
      // 建立 —— 否则首轮以 anon 做逐行 RLS 授权，所有变更被静默过滤（见 lib/supabase/client）。
      const { data } = await supabase.auth.getSession();
      if (cancelled) return;
      await supabase.realtime.setAuth(data.session?.access_token ?? null);
      if (cancelled) return;

      unsubscribe = subscribeProject(
        supabase,
        { projectId },
        {
          onNodeChange: (change) => useCanvasStore.getState().applyRemoteNode(change),
          onEdgeChange: (change) => useCanvasStore.getState().applyRemoteEdge(change),
          onGenerationChange: (change) => useCanvasStore.getState().applyRemoteGeneration(change),
          onStatusChange: (s) => setStatus(s),
        },
      );
    })();

    return () => {
      cancelled = true;
      unsubscribe();
      setStatus('closed');
    };
  }, [projectId]);

  return status;
}
