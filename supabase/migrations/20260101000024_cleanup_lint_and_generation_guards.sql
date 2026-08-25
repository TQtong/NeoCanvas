-- ============================================================================
-- 迁移 0024：清理函数静态可检验化与生成约束收尾
--
-- 旧清理函数使用会话临时表，运行有效但 PostgreSQL 静态检查器无法解析。这里改为两段
-- 可静态分析的集合语句，并保留相同的业务判定与返回语义。
-- ============================================================================

create or replace function private.cleanup_orphan_assets(p_retention_days integer default 7)
returns integer
language plpgsql
security definer
set search_path = public, storage
as $$
declare
  v_count integer;
begin
  delete from storage.objects o
   using public.assets a
   where o.bucket_id = a.storage_bucket
     and o.name = a.storage_path
     and a.created_at < now() - make_interval(days => p_retention_days)
     and not exists (select 1 from public.canvas_nodes n where n.asset_id = a.id)
     and not exists (select 1 from public.generations g where g.result_asset_id = a.id)
     and not exists (
       select 1
         from public.messages m,
              lateral jsonb_array_elements(m.attachments) e
        where e ->> 'assetId' = a.id::text
     );

  with removed as (
    delete from public.assets a
     where a.created_at < now() - make_interval(days => p_retention_days)
       and not exists (select 1 from public.canvas_nodes n where n.asset_id = a.id)
       and not exists (select 1 from public.generations g where g.result_asset_id = a.id)
       and not exists (
         select 1
           from public.messages m,
                lateral jsonb_array_elements(m.attachments) e
          where e ->> 'assetId' = a.id::text
       )
    returning 1
  )
  select count(*) into v_count from removed;

  return v_count;
end;
$$;

comment on function private.cleanup_orphan_assets is
  '回收既不被节点 / 生成 / 附件引用且超过保留期的孤儿资产；实现可通过数据库静态检查。';
