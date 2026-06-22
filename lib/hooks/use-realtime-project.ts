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
import { useChatStore } from '@/stores/chat-store';

/** 实时连接状态。 */
export type RealtimeStatus = 'connecting' | 'subscribed' | 'closed' | 'error' | 'timed_out';

/**
 * 装配项目实时订阅。
 *
 * @param projectId - 项目标识
 * @param conversationId - 主会话标识（用于对话多设备同步）
 * @returns 当前实时连接状态
 */
export function useRealtimeProject(
  projectId: string,
  conversationId: string | null,
): RealtimeStatus {
  const [status, setStatus] = useState<RealtimeStatus>('connecting');

  useEffect(() => {
    const supabase = getBrowserSupabase();
    const unsubscribe = subscribeProject(
      supabase,
      { projectId, conversationId },
      {
        onNodeChange: (change) => useCanvasStore.getState().applyRemoteNode(change),
        onEdgeChange: (change) => useCanvasStore.getState().applyRemoteEdge(change),
        onGenerationChange: (change) => useCanvasStore.getState().applyRemoteGeneration(change),
        onMessageChange: (change) => useChatStore.getState().applyRemoteMessage(change),
        onStatusChange: (s) => setStatus(s),
      },
    );

    return () => {
      unsubscribe();
      setStatus('closed');
    };
  }, [projectId, conversationId]);

  return status;
}
