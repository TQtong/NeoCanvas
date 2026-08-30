-- plpgsql_check 无法静态解析临时表引用；改为逐行回收，保持与原实现相同的删除语义。
create or replace function private.cleanup_orphan_assets(p_retention_days integer default 7)
returns integer
language plpgsql
security definer
set search_path = public, storage
as $$
declare
  v_orphan record;
  v_count integer := 0;
begin
  for v_orphan in
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
       )
  loop
    delete from storage.objects
     where bucket_id = v_orphan.storage_bucket and name = v_orphan.storage_path;
    delete from public.assets where id = v_orphan.id;
    if found then v_count := v_count + 1; end if;
  end loop;
  return v_count;
end;
$$;

comment on function private.cleanup_orphan_assets is
  '回收未被 Canvas、生成、Flow 输出、修订或消息引用且超过保留期的孤儿资产。';
