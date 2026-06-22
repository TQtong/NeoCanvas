-- ============================================================================
-- 迁移 0008：Realtime 发布配置
--
-- 将 canvas_nodes、canvas_edges、generations、messages 纳入 Realtime 发布，并设置
-- 完整副本标识（replica identity full），使 UPDATE/DELETE 事件携带足够旧值供客户端
-- 做精确局部更新（第 03 篇第九节、第 06 篇第六节）。
-- ============================================================================

-- 确保发布存在（Supabase 默认已创建 supabase_realtime）
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end
$$;

-- 完整副本标识
alter table public.canvas_nodes replica identity full;
alter table public.canvas_edges replica identity full;
alter table public.generations replica identity full;
alter table public.messages replica identity full;

-- 幂等地把表加入发布
do $$
declare
  v_table text;
  v_tables text[] := array['canvas_nodes', 'canvas_edges', 'generations', 'messages'];
begin
  foreach v_table in array v_tables loop
    if not exists (
      select 1
        from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = v_table
    ) then
      execute format('alter publication supabase_realtime add table public.%I', v_table);
    end if;
  end loop;
end
$$;
