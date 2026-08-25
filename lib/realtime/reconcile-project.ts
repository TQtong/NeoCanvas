/**
 * Realtime 重连后的项目权威快照加载。
 *
 * 频道断线期间的数据库变更不会自动补发，因此重连必须重新读取项目、画布、会话、消息与生成
 * 状态。此模块只负责读取，不直接修改 Store，便于状态机测试并保持数据库为唯一真相来源。
 *
 * @module lib/realtime/reconcile-project
 */

import type {
  CanvasEdgeRow,
  CanvasNodeRow,
  ConversationRow,
  GenerationRow,
  MessageRow,
  Viewport,
} from '@/types';
import type { TypedSupabaseClient } from '@/lib/supabase/types';
import { MESSAGES_PAGE_SIZE } from '@/lib/data/mappers';

/** 项目在一次校正读取中的完整快照。 */
export interface RealtimeProjectSnapshot {
  viewport: Viewport;
  nodes: CanvasNodeRow[];
  edges: CanvasEdgeRow[];
  conversations: ConversationRow[];
  messages: MessageRow[];
  generations: GenerationRow[];
  hasMoreMessages: boolean;
}

/**
 * 加载项目重连快照。
 *
 * @param supabase - 已绑定当前用户 JWT 的浏览器客户端
 * @param projectId - 项目标识
 * @param conversationId - 当前会话标识；为空时不查询消息
 * @returns 权威快照
 * @throws 项目无权访问、查询失败或会话不属于该项目时抛出错误
 */
export async function loadRealtimeProjectSnapshot(
  supabase: TypedSupabaseClient,
  projectId: string,
  conversationId: string | null,
): Promise<RealtimeProjectSnapshot> {
  const [projectResult, nodesResult, edgesResult, conversationsResult] = await Promise.all([
    supabase
      .from('projects')
      .select('viewport')
      .eq('id', projectId)
      .eq('is_deleted', false)
      .single(),
    supabase
      .from('canvas_nodes')
      .select('*')
      .eq('project_id', projectId)
      .order('z_index', { ascending: true }),
    supabase.from('canvas_edges').select('*').eq('project_id', projectId),
    supabase
      .from('conversations')
      .select('*')
      .eq('project_id', projectId)
      .order('updated_at', { ascending: false })
      .order('id', { ascending: false }),
  ]);

  const firstError =
    projectResult.error ?? nodesResult.error ?? edgesResult.error ?? conversationsResult.error;
  if (firstError) throw firstError;
  if (!projectResult.data) throw new Error('项目不存在或当前用户无权访问');

  const conversation = conversationId
    ? (conversationsResult.data ?? []).find((item) => item.id === conversationId)
    : null;
  if (conversationId && !conversation) {
    throw new Error('当前会话不属于该项目或已经被删除');
  }

  const messagesPromise = conversationId
    ? supabase
        .from('messages')
        .select('*')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(MESSAGES_PAGE_SIZE)
    : Promise.resolve({ data: [] as MessageRow[], error: null });

  // 当前会话的全部任务用于恢复消息关联；其他会话只读取非终态任务以校正画布进行态。
  const generationsQuery = supabase
    .from('generations')
    .select('*')
    .eq('project_id', projectId)
    .order('created_at', { ascending: true });
  const generationsPromise = conversationId
    ? generationsQuery.or(`conversation_id.eq.${conversationId},status.in.(pending,running)`)
    : generationsQuery.in('status', ['pending', 'running']);

  const [messagesResult, generationsResult] = await Promise.all([
    messagesPromise,
    generationsPromise,
  ]);
  if (messagesResult.error) throw messagesResult.error;
  if (generationsResult.error) throw generationsResult.error;

  const descendingMessages = messagesResult.data ?? [];
  return {
    viewport: projectResult.data.viewport,
    nodes: nodesResult.data ?? [],
    edges: edgesResult.data ?? [],
    conversations: conversationsResult.data ?? [],
    messages: descendingMessages.slice().reverse(),
    generations: generationsResult.data ?? [],
    hasMoreMessages: descendingMessages.length >= MESSAGES_PAGE_SIZE,
  };
}
