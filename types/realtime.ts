/**
 * 实时面频道契约（第 06 篇第六节）。
 *
 * 实时面以「项目」为粒度组织，频道名形如 `project:{projectId}`；监听 `canvas_nodes`、
 * `canvas_edges`、`generations` 三张表的行变更，以 `project_id` 过滤本项目事件。
 *
 * @module types/realtime
 */

import type { CanvasEdgeRow, CanvasNodeRow, GenerationRow, MessageRow } from './database';

/** 工作台向界面暴露的稳定实时连接状态。 */
export type RealtimeStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'error';

/** 客户端持久化状态；与 Realtime 连接状态相互独立。 */
export type SyncState =
  | { status: 'saved'; confirmedAt: string }
  | { status: 'saving'; pendingCount: number }
  | { status: 'offline'; pendingCount: number }
  | { status: 'error'; pendingCount: number; message: string; retryable: boolean };

/** Supabase 项目频道的底层订阅状态。 */
export type ProjectChannelStatus = 'subscribed' | 'closed' | 'error' | 'timed_out';

/** 实时变更事件类型。 */
export type RealtimeEventType = 'INSERT' | 'UPDATE' | 'DELETE';

/**
 * 构造项目频道名。
 *
 * @param projectId - 项目标识
 * @returns 频道名，形如 `project:3f...`
 */
export function projectChannelName(projectId: string): string {
  return `project:${projectId}`;
}

/**
 * 单条实时变更负载。依赖三张表设置的完整副本标识（replica identity full），
 * 因而 UPDATE/DELETE 事件携带足够的旧值供精确局部更新。
 */
export interface RealtimeChange<TRow> {
  /** 变更类型。 */
  eventType: RealtimeEventType;
  /** 表名。 */
  table: 'canvas_nodes' | 'canvas_edges' | 'generations' | 'messages';
  /** 新值（INSERT/UPDATE 携带；DELETE 时为部分旧值）。 */
  new: TRow | Record<string, never>;
  /** 旧值（UPDATE/DELETE 携带）。 */
  old: Partial<TRow> | Record<string, never>;
}

/** 三张订阅表的变更负载并集。 */
export type ProjectRealtimeChange =
  | (RealtimeChange<CanvasNodeRow> & { table: 'canvas_nodes' })
  | (RealtimeChange<CanvasEdgeRow> & { table: 'canvas_edges' })
  | (RealtimeChange<GenerationRow> & { table: 'generations' })
  | (RealtimeChange<MessageRow> & { table: 'messages' });

/**
 * 订阅回调集合，由 `lib/realtime` 注入并分发到画布 / 对话状态库。
 */
export interface ProjectSubscriptionHandlers {
  /** 画布节点变更。 */
  onNodeChange?: (change: RealtimeChange<CanvasNodeRow>) => void;
  /** 画布边变更。 */
  onEdgeChange?: (change: RealtimeChange<CanvasEdgeRow>) => void;
  /** 生成任务变更。 */
  onGenerationChange?: (change: RealtimeChange<GenerationRow>) => void;
  /** 消息变更（多设备对话同步，可选）。 */
  onMessageChange?: (change: RealtimeChange<MessageRow>) => void;
  /** 订阅状态变化（用于断线提示与重连）。 */
  onStatusChange?: (status: ProjectChannelStatus) => void;
}
