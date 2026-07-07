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
  AssetRow,
  CanvasEdgeRow,
  CanvasNodeRow,
  ConversationRow,
  MessageRow,
  ProjectRow,
} from '@/types';
import type { TypedSupabaseClient } from '@/lib/supabase/types';
import { resolveAssetViews } from '@/lib/storage/signed-url';
import { MESSAGES_PAGE_SIZE } from './mappers';

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
  /** 主会话的最近一页历史消息（按时间升序）。 */
  messages: MessageRow[];
  /** 是否还有更早的历史消息可加载（keyset 分页）。 */
  hasMoreMessages: boolean;
}

/**
 * 为服务端初始快照补齐媒体节点的运行时 URL。
 *
 * 客户端仍会用 `useCanvasMedia` 做补漏与过期续签；这里先把首屏所需的 `src`
 * 注入到非持久化 data 字段，避免刷新后 image/video 节点在异步解析前长期显示为空白骨架。
 */
async function attachRuntimeMediaUrls(
  supabase: TypedSupabaseClient,
  nodes: CanvasNodeRow[],
): Promise<CanvasNodeRow[]> {
  const assetIds = Array.from(
    new Set(
      nodes
        .filter((node) => (node.type === 'image' || node.type === 'video') && node.asset_id)
        .map((node) => node.asset_id as string),
    ),
  );
  if (assetIds.length === 0) return nodes;

  const { data } = await supabase.from('assets').select('*').in('id', assetIds);
  const assetRows = (data ?? []) as AssetRow[];
  if (assetRows.length === 0) return nodes;

  const views = await resolveAssetViews(supabase, assetRows);
  const byAssetId = new Map(views.map((view) => [view.id, view]));

  return nodes.map((node) => {
    if (node.type !== 'image' && node.type !== 'video') return node;
    if (!node.asset_id) return node;
    const view = byAssetId.get(node.asset_id);
    if (!view?.url) return node;

    return {
      ...node,
      data: {
        ...node.data,
        src: view.url,
        ...(node.type === 'image'
          ? { thumbnailSrc: view.thumbnailUrl }
          : { posterSrc: view.thumbnailUrl }),
      },
    };
  });
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
  let hasMoreMessages = false;
  if (conversation) {
    // 取最近一页（DESC + 主键决胜），再翻转为升序展示；命中复合索引、避免长会话一次全量
    const { data: msgs } = await supabase
      .from('messages')
      .select('*')
      .eq('conversation_id', conversation.id)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(MESSAGES_PAGE_SIZE);
    const page = msgs ?? [];
    hasMoreMessages = page.length >= MESSAGES_PAGE_SIZE;
    messages = page.slice().reverse();
  }

  const nodes = await attachRuntimeMediaUrls(supabase, nodesResult.data ?? []);

  return {
    project,
    nodes,
    edges: edgesResult.data ?? [],
    conversation,
    messages,
    hasMoreMessages,
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
