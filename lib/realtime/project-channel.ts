/**
 * 按项目订阅 Realtime 的封装（第 06 篇第六节）。
 *
 * 进入设计页时订阅 `project:{projectId}` 频道，监听 `canvas_nodes`、`canvas_edges`、
 * `generations` 的行变更（以 project_id 过滤），并按需监听 `messages`（以会话过滤，
 * 用于多设备对话同步）。订阅经 RLS 授权，客户端只能收到自己有权访问的行。
 *
 * @module lib/realtime/project-channel
 */

import type { RealtimeChannel, RealtimePostgresChangesPayload } from '@supabase/supabase-js';
import {
  projectChannelName,
  type ProjectSubscriptionHandlers,
  type RealtimeChange,
  type RealtimeEventType,
} from '@/types';
import type { TypedSupabaseClient } from '@/lib/supabase/types';

/** 订阅参数。 */
export interface SubscribeProjectOptions {
  /** 项目标识。 */
  projectId: string;
  /** 主会话标识（用于过滤 messages，启用对话多设备同步）。 */
  conversationId?: string | null;
}

/**
 * 把 supabase 的变更负载归一为本项目的 {@link RealtimeChange}。
 */
function toChange<T extends Record<string, unknown>>(
  payload: RealtimePostgresChangesPayload<T>,
): RealtimeChange<T> {
  return {
    eventType: payload.eventType as RealtimeEventType,
    table: (payload.table as RealtimeChange<T>['table']) ?? 'canvas_nodes',
    new: (payload.new ?? {}) as T,
    old: (payload.old ?? {}) as Partial<T>,
  };
}

/**
 * 订阅一个项目频道。
 *
 * @param supabase - 浏览器端 Supabase 客户端
 * @param options - 订阅参数
 * @param handlers - 各表变更与状态回调
 * @returns 取消订阅函数；离开项目时调用以释放频道
 */
export function subscribeProject(
  supabase: TypedSupabaseClient,
  options: SubscribeProjectOptions,
  handlers: ProjectSubscriptionHandlers,
): () => void {
  const { projectId, conversationId } = options;
  const channel: RealtimeChannel = supabase.channel(projectChannelName(projectId), {
    config: { broadcast: { self: false } },
  });

  // 画布节点
  channel.on(
    'postgres_changes',
    { event: '*', schema: 'public', table: 'canvas_nodes', filter: `project_id=eq.${projectId}` },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (payload: RealtimePostgresChangesPayload<any>) => {
      handlers.onNodeChange?.(toChange(payload));
    },
  );

  // 画布边
  channel.on(
    'postgres_changes',
    { event: '*', schema: 'public', table: 'canvas_edges', filter: `project_id=eq.${projectId}` },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (payload: RealtimePostgresChangesPayload<any>) => {
      handlers.onEdgeChange?.(toChange(payload));
    },
  );

  // 生成任务
  channel.on(
    'postgres_changes',
    { event: '*', schema: 'public', table: 'generations', filter: `project_id=eq.${projectId}` },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (payload: RealtimePostgresChangesPayload<any>) => {
      handlers.onGenerationChange?.(toChange(payload));
    },
  );

  // 消息（可选，按会话过滤）
  if (conversationId) {
    channel.on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'messages',
        filter: `conversation_id=eq.${conversationId}`,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (payload: RealtimePostgresChangesPayload<any>) => {
        handlers.onMessageChange?.(toChange(payload));
      },
    );
  }

  channel.subscribe((status) => {
    switch (status) {
      case 'SUBSCRIBED':
        handlers.onStatusChange?.('subscribed');
        break;
      case 'CLOSED':
        handlers.onStatusChange?.('closed');
        break;
      case 'CHANNEL_ERROR':
        handlers.onStatusChange?.('error');
        break;
      case 'TIMED_OUT':
        handlers.onStatusChange?.('timed_out');
        break;
      default:
        break;
    }
  });

  return () => {
    void supabase.removeChannel(channel);
  };
}
