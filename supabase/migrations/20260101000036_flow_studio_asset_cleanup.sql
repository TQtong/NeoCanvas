-- Flow 运行输出与 revision 固定资产均属于有效引用，孤儿回收必须排除。
create or replace function private.cleanup_orphan_assets(p_retention_days integer default 7)
returns integer
language plpgsql
security definer
set search_path = public, storage
as $$
declare
  v_count integer;
begin
  create temporary table _orphans on commit drop as
    select a.id, a.storage_bucket, a.storage_path
      from public.assets a
     where a.created_at < now() - make_interval(days => p_retention_days)
       and not exists (select 1 from public.canvas_nodes n where n.asset_id = a.id)
       and not exists (select 1 from public.generations g where g.result_asset_id = a.id)
       and not exists (select 1 from public.workflow_run_outputs o where o.asset_id = a.id)
       and not exists (select 1 from public.workflow_revision_asset_refs r where r.asset_id = a.id)
       and not exists (
         select 1 from public.messages m,
              lateral jsonb_array_elements(m.attachments) e
          where e ->> 'assetId' = a.id::text
       );

  delete from storage.objects o using _orphans x
   where o.bucket_id = x.storage_bucket and o.name = x.storage_path;
  with removed as (
    delete from public.assets a using _orphans x where a.id = x.id returning 1
  ) select count(*) into v_count from removed;
  return v_count;
end;
$$;

comment on function private.cleanup_orphan_assets is
  '回收未被 Canvas、生成、Flow 输出、修订或消息引用且超过保留期的孤儿资产。';
