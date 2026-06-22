-- ============================================================================
-- 迁移 0004：索引
--
-- 按第 03 篇第四节的高频查询路径设计。
-- ============================================================================

-- 「最近项目」：按主、过滤软删、按更新时间倒序
create index projects_owner_recent_idx
  on public.projects (owner_id, is_deleted, updated_at desc);

-- 画布整体加载：按项目取全部节点
create index canvas_nodes_project_idx on public.canvas_nodes (project_id);

-- 按层级取序
create index canvas_nodes_project_z_idx on public.canvas_nodes (project_id, z_index);

-- 取某画板的子节点
create index canvas_nodes_parent_idx on public.canvas_nodes (parent_id)
  where parent_id is not null;

-- 节点绑定的资产 / 生成（占位转化、清理孤儿时反查）
create index canvas_nodes_asset_idx on public.canvas_nodes (asset_id)
  where asset_id is not null;
create index canvas_nodes_generation_idx on public.canvas_nodes (generation_id)
  where generation_id is not null;

-- 边：按项目，及按源 / 目标节点
create index canvas_edges_project_idx on public.canvas_edges (project_id);
create index canvas_edges_source_idx on public.canvas_edges (source_node_id);
create index canvas_edges_target_idx on public.canvas_edges (target_node_id);

-- 会话历史：按会话、按时间升序
create index messages_conversation_created_idx
  on public.messages (conversation_id, created_at);

-- 生成任务：按状态批量拉取运行中任务（轮询）
create index generations_status_idx on public.generations (status);

-- 生成历史：按项目、按时间倒序
create index generations_project_created_idx
  on public.generations (project_id, created_at desc);

-- 回调按外部任务号反查
create index generations_external_job_idx on public.generations (external_job_id)
  where external_job_id is not null;

-- 资产：按主时间倒序，及按项目
create index assets_owner_created_idx on public.assets (owner_id, created_at desc);
create index assets_project_idx on public.assets (project_id)
  where project_id is not null;

-- 模型目录：驱动选择条
create index model_catalog_active_sort_idx on public.model_catalog (is_active, sort_order);
