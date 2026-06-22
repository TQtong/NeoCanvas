-- ============================================================================
-- 迁移 0006：行级安全（RLS）
--
-- 所有业务表开启 RLS，策略以「行归属于当前认证用户」为统一范式（第 03 篇第五节）。
-- 服务角色（service_role）绕过 RLS，故服务端写入（生成落库、助手消息）无需策略。
-- ============================================================================

alter table public.profiles enable row level security;
alter table public.projects enable row level security;
alter table public.canvas_nodes enable row level security;
alter table public.canvas_edges enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.generations enable row level security;
alter table public.assets enable row level security;
alter table public.model_catalog enable row level security;

-- ----------------------------------------------------------------------------
-- profiles：仅本人读写
-- ----------------------------------------------------------------------------
create policy profiles_select_self on public.profiles
  for select using (id = auth.uid ());
create policy profiles_update_self on public.profiles
  for update using (id = auth.uid ()) with check (id = auth.uid ());
-- 注册建档由 handle_new_user（security definer）完成，客户端不直接 insert。

-- ----------------------------------------------------------------------------
-- projects：owner 读 / 增 / 改；删除以软删（update is_deleted）表达，无物理删除策略
-- ----------------------------------------------------------------------------
create policy projects_select_own on public.projects
  for select using (owner_id = auth.uid ());
create policy projects_insert_own on public.projects
  for insert with check (owner_id = auth.uid ());
create policy projects_update_own on public.projects
  for update using (owner_id = auth.uid ()) with check (owner_id = auth.uid ());

-- ----------------------------------------------------------------------------
-- canvas_nodes：所属项目归本人即可读写；插入须 created_by = 自己
-- ----------------------------------------------------------------------------
create policy canvas_nodes_select on public.canvas_nodes
  for select using (private.is_project_owner (project_id));
create policy canvas_nodes_insert on public.canvas_nodes
  for insert with check (
    private.is_project_owner (project_id) and created_by = auth.uid ()
  );
create policy canvas_nodes_update on public.canvas_nodes
  for update using (private.is_project_owner (project_id))
  with check (private.is_project_owner (project_id));
create policy canvas_nodes_delete on public.canvas_nodes
  for delete using (private.is_project_owner (project_id));

-- ----------------------------------------------------------------------------
-- canvas_edges：同上，按项目归属
-- ----------------------------------------------------------------------------
create policy canvas_edges_select on public.canvas_edges
  for select using (private.is_project_owner (project_id));
create policy canvas_edges_insert on public.canvas_edges
  for insert with check (private.is_project_owner (project_id));
create policy canvas_edges_update on public.canvas_edges
  for update using (private.is_project_owner (project_id))
  with check (private.is_project_owner (project_id));
create policy canvas_edges_delete on public.canvas_edges
  for delete using (private.is_project_owner (project_id));

-- ----------------------------------------------------------------------------
-- conversations：按项目归属读写
-- ----------------------------------------------------------------------------
create policy conversations_select on public.conversations
  for select using (private.is_project_owner (project_id));
create policy conversations_insert on public.conversations
  for insert with check (private.is_project_owner (project_id));
create policy conversations_update on public.conversations
  for update using (private.is_project_owner (project_id))
  with check (private.is_project_owner (project_id));

-- ----------------------------------------------------------------------------
-- messages：读所属项目的消息；客户端只能写自己的「用户消息」，助手消息由服务端写
-- ----------------------------------------------------------------------------
create policy messages_select on public.messages
  for select using (private.owns_conversation (conversation_id));
create policy messages_insert_user on public.messages
  for insert with check (
    private.owns_conversation (conversation_id) and role = 'user'
  );

-- ----------------------------------------------------------------------------
-- generations：客户端只读所属项目的任务；创建与状态写入恒由能力面服务端完成
-- ----------------------------------------------------------------------------
create policy generations_select on public.generations
  for select using (private.is_project_owner (project_id));

-- ----------------------------------------------------------------------------
-- assets：仅本人读写（生成产出资产由服务端登记）
-- ----------------------------------------------------------------------------
create policy assets_select_own on public.assets
  for select using (owner_id = auth.uid ());
create policy assets_insert_own on public.assets
  for insert with check (owner_id = auth.uid ());
create policy assets_update_own on public.assets
  for update using (owner_id = auth.uid ()) with check (owner_id = auth.uid ());
create policy assets_delete_own on public.assets
  for delete using (owner_id = auth.uid ());

-- ----------------------------------------------------------------------------
-- model_catalog：已认证用户只读 is_active 行；写入仅限管理侧（服务角色）
-- ----------------------------------------------------------------------------
create policy model_catalog_select_active on public.model_catalog
  for select to authenticated using (is_active = true);
