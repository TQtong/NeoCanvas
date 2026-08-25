'use client';

/**
 * 项目 Realtime 订阅与重连校正钩子。
 *
 * 频道事件负责低延迟增量投影；每次首次订阅、断线重连、浏览器恢复在线或页面从休眠恢复时，
 * 都重新读取数据库权威快照，再由 CanvasStore/ChatStore 保留本地未确认状态地完成合并。
 *
 * @module lib/hooks/use-realtime-project
 */

import { useEffect, useState } from 'react';
import type { RealtimeStatus } from '@/types';
import { getBrowserSupabase } from '@/lib/supabase/client';
import { subscribeProject } from '@/lib/realtime/project-channel';
import { loadRealtimeProjectSnapshot } from '@/lib/realtime/reconcile-project';
import { useCanvasStore } from '@/stores/canvas-store';
import { useChatStore } from '@/stores/chat-store';

export type { RealtimeStatus } from '@/types';

/** 断线重连退避序列，达到上限后持续使用最后一档。 */
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const;

/**
 * 装配项目实时订阅。
 *
 * @param projectId - 项目标识
 * @param conversationId - 当前会话标识，用于消息过滤和快照校正
 * @returns 当前实时连接状态
 */
export function useRealtimeProject(
  projectId: string,
  conversationId: string | null,
): RealtimeStatus {
  const [status, setStatus] = useState<RealtimeStatus>('connecting');

  useEffect(() => {
    const supabase = getBrowserSupabase();
    let disposed = false;
    let everConnected = false;
    let reconnectAttempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: (() => void) | null = null;
    let activeChannelId = 0;
    let connecting = false;
    const reconcilePromises = new Map<number, Promise<void>>();
    const bufferingChannelIds = new Set<number>();
    let bufferedRealtimeEvents: Array<{ channelId: number; apply: () => void }> = [];
    let currentStatus: RealtimeStatus = 'connecting';

    /** 只在仍挂载时更新状态，避免卸载后的 React 更新。 */
    const publishStatus = (next: RealtimeStatus): void => {
      currentStatus = next;
      if (!disposed) setStatus(next);
    };

    /** 释放当前频道；递增代次使旧频道的迟到回调失效。 */
    const closeChannel = (): void => {
      const closingChannelId = activeChannelId;
      activeChannelId += 1;
      bufferingChannelIds.delete(closingChannelId);
      bufferedRealtimeEvents = bufferedRealtimeEvents.filter(
        (event) => event.channelId !== closingChannelId,
      );
      const close = unsubscribe;
      unsubscribe = null;
      close?.();
    };

    /**
     * 快照校正期间缓存频道事件。否则“订阅成功 → 读取快照”的窗口内若收到 INSERT，
     * 较早发起但较晚返回的快照会覆盖该事件，造成已确认数据在页面中丢失。
     */
    const applyRealtimeEvent = (channelId: number, apply: () => void): void => {
      if (disposed || channelId !== activeChannelId) return;
      if (bufferingChannelIds.has(channelId)) {
        bufferedRealtimeEvents.push({ channelId, apply });
        return;
      }
      apply();
    };

    /** 读取数据库快照，校正两套 Store 后按原始顺序重放校正期间收到的频道事件。 */
    const reconcile = (channelId: number): Promise<void> => {
      const existing = reconcilePromises.get(channelId);
      if (existing) return existing;

      bufferingChannelIds.add(channelId);
      const promise = (async () => {
        const snapshot = await loadRealtimeProjectSnapshot(supabase, projectId, conversationId);
        if (disposed || channelId !== activeChannelId) return;
        useCanvasStore.getState().reconcileSnapshot({
          nodeRows: snapshot.nodes,
          edgeRows: snapshot.edges,
          viewport: snapshot.viewport,
        });
        useCanvasStore.getState().reconcileGenerationSnapshot(snapshot.generations);
        useChatStore.getState().reconcileSnapshot({
          conversations: snapshot.conversations,
          messages: snapshot.messages,
          generations: snapshot.generations,
          hasMoreMessages: snapshot.hasMoreMessages,
        });

        const pendingEvents = bufferedRealtimeEvents.filter(
          (event) => event.channelId === channelId,
        );
        bufferedRealtimeEvents = bufferedRealtimeEvents.filter(
          (event) => event.channelId !== channelId,
        );
        bufferingChannelIds.delete(channelId);
        for (const event of pendingEvents) event.apply();
      })().finally(() => {
        reconcilePromises.delete(channelId);
        bufferingChannelIds.delete(channelId);
        bufferedRealtimeEvents = bufferedRealtimeEvents.filter(
          (event) => event.channelId !== channelId,
        );
      });
      reconcilePromises.set(channelId, promise);
      return promise;
    };

    /** 安排下一次重连；离线时等待 online 事件，不做无意义网络循环。 */
    const scheduleReconnect = (immediate = false): void => {
      if (disposed) return;
      closeChannel();
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;

      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        publishStatus('disconnected');
        return;
      }

      publishStatus(everConnected ? 'reconnecting' : 'connecting');
      const delay = immediate
        ? 0
        : RETRY_DELAYS_MS[Math.min(reconnectAttempt, RETRY_DELAYS_MS.length - 1)];
      reconnectAttempt += 1;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void connect();
      }, delay);
    };

    /** 建立一条新频道；连接与快照校正均成功后才对界面宣布 connected。 */
    async function connect(): Promise<void> {
      if (disposed || connecting) return;
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        publishStatus('disconnected');
        return;
      }
      connecting = true;
      closeChannel();
      const channelId = ++activeChannelId;
      publishStatus(everConnected ? 'reconnecting' : 'connecting');

      try {
        const { data, error } = await supabase.auth.getSession();
        if (error) throw error;
        if (disposed || channelId !== activeChannelId) return;
        await supabase.realtime.setAuth(data.session?.access_token ?? null);
        if (disposed || channelId !== activeChannelId) return;

        unsubscribe = subscribeProject(
          supabase,
          { projectId, conversationId },
          {
            onNodeChange: (change) =>
              applyRealtimeEvent(channelId, () =>
                useCanvasStore.getState().applyRemoteNode(change),
              ),
            onEdgeChange: (change) =>
              applyRealtimeEvent(channelId, () =>
                useCanvasStore.getState().applyRemoteEdge(change),
              ),
            onGenerationChange: (change) => {
              applyRealtimeEvent(channelId, () => {
                useCanvasStore.getState().applyRemoteGeneration(change);
                useChatStore.getState().applyRemoteGeneration(change);
              });
            },
            onMessageChange: (change) =>
              applyRealtimeEvent(channelId, () =>
                useChatStore.getState().applyRemoteMessage(change),
              ),
            onStatusChange: (channelStatus) => {
              if (disposed || channelId !== activeChannelId) return;
              if (channelStatus === 'subscribed') {
                void (async () => {
                  try {
                    await reconcile(channelId);
                    if (disposed || channelId !== activeChannelId) return;
                    everConnected = true;
                    reconnectAttempt = 0;
                    publishStatus('connected');
                  } catch {
                    if (disposed || channelId !== activeChannelId) return;
                    publishStatus('error');
                    scheduleReconnect();
                  }
                })();
                return;
              }

              if (channelStatus === 'closed') {
                publishStatus('disconnected');
              } else {
                publishStatus('error');
              }
              scheduleReconnect();
            },
          },
        );
      } catch {
        if (!disposed && channelId === activeChannelId) {
          publishStatus('error');
          scheduleReconnect();
        }
      } finally {
        connecting = false;
      }
    }

    const handleOffline = (): void => {
      closeChannel();
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      publishStatus('disconnected');
    };
    const handleOnline = (): void => scheduleReconnect(true);
    const handleVisibility = (): void => {
      if (document.visibilityState !== 'visible') return;
      if (currentStatus === 'connected') {
        publishStatus('reconnecting');
        void reconcile(activeChannelId)
          .then(() => publishStatus('connected'))
          .catch(() => scheduleReconnect());
      } else {
        scheduleReconnect(true);
      }
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    document.addEventListener('visibilitychange', handleVisibility);
    void connect();

    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      closeChannel();
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [conversationId, projectId]);

  return status;
}
