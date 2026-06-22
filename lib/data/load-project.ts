import 'server-only';

/**
 * 设计页初始数据加载（第 04 篇第二节「服务端预取 + 客户端水合」）。
 *
 * 服务端组件先取项目元信息、画布节点与边、主会话与历史消息，作为快照传给客户端工作台
 * 进行水合；之后一切交互与同步都在客户端发生。
 *
 * @module lib/data/load-project
 */

import type {
  CanvasEdgeRow,
  CanvasNodeRow,
  ConversationRow,
  MessageRow,
  ProjectRow,
} from '@/types';
import type { TypedSupabaseClient } from '@/lib/supabase/types';

/** 设计页初始数据包。 */
export interface ProjectBundle {
  /** 项目元信息。 */
  project: ProjectRow;
  /** 画布节点（按 z_index 升序）。 */
  nodes: CanvasNodeRow[];
  /** 画布边。 */
  edges: CanvasEdgeRow[];
  /** 主会话（最早创建的一条）。 */
  conversation: ConversationRow | null;
  /** 主会话的历史消息（按时间升序）。 */
  messages: MessageRow[];
}

/**
 * 加载设计页初始数据包。RLS 确保只能取到归属本人的项目。
 *
 * @param supabase - 服务端 Supabase 客户端
 * @param projectId - 项目标识
 * @returns 数据包；项目不存在或无权访问时返回 null
 */
export async function loadProjectBundle(
  supabase: TypedSupabaseClient,
  projectId: string,
): Promise<ProjectBundle | null> {
  const { data: project } = await supabase
    .from('projects')
    .select('*')
    .eq('id', projectId)
    .eq('is_deleted', false)
    .maybeSingle();

  if (!project) return null;

  const [nodesResult, edgesResult, conversationResult] = await Promise.all([
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
      .order('created_at', { ascending: true })
      .limit(1),
  ]);

  const conversation = conversationResult.data?.[0] ?? null;
  let messages: MessageRow[] = [];
  if (conversation) {
    const { data: msgs } = await supabase
      .from('messages')
      .select('*')
      .eq('conversation_id', conversation.id)
      .order('created_at', { ascending: true });
    messages = msgs ?? [];
  }

  return {
    project,
    nodes: nodesResult.data ?? [],
    edges: edgesResult.data ?? [],
    conversation,
    messages,
  };
}

/**
 * 标记项目「最近打开时间」。在设计页加载后调用，辅助排序。
 *
 * @param supabase - 服务端 Supabase 客户端
 * @param projectId - 项目标识
 */
export async function touchProjectOpened(
  supabase: TypedSupabaseClient,
  projectId: string,
): Promise<void> {
  await supabase
    .from('projects')
    .update({ last_opened_at: new Date().toISOString() })
    .eq('id', projectId);
}
