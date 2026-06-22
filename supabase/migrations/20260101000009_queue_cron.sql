-- ============================================================================
-- 迁移 0009：队列、定时任务与生命周期清理
--
-- 建立 Supabase Queues（pgmq）承载待处理生成任务，提供供 Edge Functions 调用的
-- 队列 RPC 包装，建立数据库内调用 Edge Function 的助手，并以 pg_cron 调度推进与
-- 清理任务（第 02 篇第四节、第 03 篇第十节、第 05 篇第五节）。
--
-- 部署前置：运维须在 Vault 写入两条机密，供数据库回调 Edge Function：
--   select vault.create_secret('https://<ref>.supabase.co/functions/v1', 'edge_base_url');
--   select vault.create_secret('<service_role_key>', 'service_role_key');
-- 详见 docs/SETUP.md。
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 持久队列：待处理生成任务
-- ----------------------------------------------------------------------------
select pgmq.create('generation_jobs');

-- 队列 RPC 包装（仅服务角色可调用，供 Edge Functions 经 PostgREST rpc 访问）
create or replace function public.enqueue_generation_job(p_generation_id uuid)
returns bigint
language plpgsql
security definer
set search_path = public, pgmq
as $$
begin
  return pgmq.send('generation_jobs', jsonb_build_object('generationId', p_generation_id));
end;
$$;
comment on function public.enqueue_generation_job is '将生成任务投入待处理队列，返回消息 id。';

create or replace function public.read_generation_jobs(p_qty integer default 5, p_vt integer default 90)
returns table (msg_id bigint, read_ct integer, message jsonb)
language plpgsql
security definer
set search_path = public, pgmq
as $$
begin
  return query
    select r.msg_id, r.read_ct, r.message
      from pgmq.read('generation_jobs', p_vt, p_qty) as r;
end;
$$;
comment on function public.read_generation_jobs is '读取待处理队列消息（不可见时长 p_vt 秒，含已读次数），供消费函数处理。';

create or replace function public.delete_generation_job(p_msg_id bigint)
returns boolean
language plpgsql
security definer
set search_path = public, pgmq
as $$
begin
  return pgmq.delete('generation_jobs', p_msg_id);
end;
$$;
comment on function public.delete_generation_job is '从待处理队列删除已处理消息。';

-- 队列 RPC 仅授予服务角色
revoke all on function public.enqueue_generation_job(uuid) from public, anon, authenticated;
revoke all on function public.read_generation_jobs(integer, integer) from public, anon, authenticated;
revoke all on function public.delete_generation_job(bigint) from public, anon, authenticated;
grant execute on function public.enqueue_generation_job(uuid) to service_role;
grant execute on function public.read_generation_jobs(integer, integer) to service_role;
grant execute on function public.delete_generation_job(bigint) to service_role;

-- ----------------------------------------------------------------------------
-- Vault 读取与 Edge Function 调用助手
-- ----------------------------------------------------------------------------
create or replace function private.get_secret(p_name text)
returns text
language sql
security definer
stable
set search_path = vault, public
as $$
  select decrypted_secret
    from vault.decrypted_secrets
   where name = p_name
   limit 1;
$$;
comment on function private.get_secret is '从 Vault 读取指定机密的明文，仅供内部函数使用。';

create or replace function private.invoke_edge_function(p_name text, p_body jsonb default '{}'::jsonb)
returns bigint
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_base text := private.get_secret('edge_base_url');
  v_key text := private.get_secret('service_role_key');
  v_request_id bigint;
begin
  if v_base is null or v_key is null then
    raise warning 'Vault 未配置 edge_base_url / service_role_key，跳过调用 %', p_name;
    return null;
  end if;

  select net.http_post(
    url := v_base || '/' || p_name,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_key
    ),
    body := p_body,
    timeout_milliseconds := 120000
  )
  into v_request_id;

  return v_request_id;
end;
$$;
comment on function private.invoke_edge_function is '由 cron / 触发器以服务角色调用面向内部的 Edge Function。';

-- ----------------------------------------------------------------------------
-- 生命周期清理（第 03 篇第十节）
-- ----------------------------------------------------------------------------

-- 超时保护：running 且长时间无进度的任务判定超时、置 failed
create or replace function private.cleanup_timed_out_generations()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_timeout_ms integer := coalesce(
    nullif(private.get_secret('generation_timeout_ms'), '')::integer,
    600000
  );
  v_count integer;
begin
  with timed_out as (
    update public.generations
       set status = 'failed',
           error = coalesce(error, '生成超时'),
           completed_at = now()
     where status = 'running'
       and updated_at < now() - make_interval(secs => v_timeout_ms / 1000.0)
    returning 1
  )
  select count(*) into v_count from timed_out;
  return v_count;
end;
$$;
comment on function private.cleanup_timed_out_generations is '将长时间停滞的 running 任务判定超时并置 failed。';

-- 软删项目过保留期后物理清理（级联删除其画布 / 会话 / 消息 / 生成）
create or replace function private.cleanup_soft_deleted_projects(p_retention_days integer default 30)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  with purged as (
    delete from public.projects
     where is_deleted = true
       and updated_at < now() - make_interval(days => p_retention_days)
    returning 1
  )
  select count(*) into v_count from purged;
  return v_count;
end;
$$;
comment on function private.cleanup_soft_deleted_projects is '物理清理超过保留期的软删项目及其级联数据。';

-- 孤儿资产回收：不被任何节点引用、不被任何生成结果引用、不被任何消息附件引用，
-- 且超过保留期者，删除其 storage 对象行与资产记录。
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
       and not exists (
         select 1 from public.canvas_nodes n where n.asset_id = a.id
       )
       and not exists (
         select 1 from public.generations g where g.result_asset_id = a.id
       )
       and not exists (
         select 1
           from public.messages m,
                lateral jsonb_array_elements(m.attachments) e
          where e ->> 'assetId' = a.id::text
       );

  -- 先删存储对象行（物理文件由 Storage 侧 GC 回收）
  delete from storage.objects o
   using _orphans x
   where o.bucket_id = x.storage_bucket
     and o.name = x.storage_path;

  -- 再删资产记录
  with removed as (
    delete from public.assets a
     using _orphans x
     where a.id = x.id
    returning 1
  )
  select count(*) into v_count from removed;

  return v_count;
end;
$$;
comment on function private.cleanup_orphan_assets is '回收既不被节点 / 生成 / 附件引用且超过保留期的孤儿资产。';

-- 每日聚合清理
create or replace function private.run_daily_cleanup()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform private.cleanup_soft_deleted_projects();
  perform private.cleanup_orphan_assets();
end;
$$;
comment on function private.run_daily_cleanup is '每日聚合执行软删清理与孤儿资产回收。';

-- ----------------------------------------------------------------------------
-- pg_cron 调度（推进两途径之一的轮询 + 队列消费兜底 + 清理）
-- ----------------------------------------------------------------------------
-- 队列消费兜底：每 15 秒触发一次消费函数（提交端亦会即时直调，此为兜底）
select cron.schedule(
  'neocanvas-process-queue',
  '15 seconds',
  $cron$ select private.invoke_edge_function('process-generation-queue'); $cron$
);

-- 轮询推进：每 30 秒拉取运行中异步任务查询进度
select cron.schedule(
  'neocanvas-poll-generations',
  '30 seconds',
  $cron$ select private.invoke_edge_function('poll-generations'); $cron$
);

-- 超时清扫：每分钟
select cron.schedule(
  'neocanvas-timeout-sweep',
  '* * * * *',
  $cron$ select private.cleanup_timed_out_generations(); $cron$
);

-- 每日清理：每天 03:00
select cron.schedule(
  'neocanvas-daily-cleanup',
  '0 3 * * *',
  $cron$ select private.run_daily_cleanup(); $cron$
);
