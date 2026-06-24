-- ============================================================================
-- 迁移 0010：后端完整性补强
--
-- 在不改动既有表语义的前提下，补齐设计文档要求但首版实现简化或遗漏的能力：
--   1. 内容安全审核结果落库（generations.moderation_*）与可配置策略表（moderation_policies）
--   2. create-project 项目级幂等（projects.client_request_id）
--   3. agent-orchestrate 助手消息去重（messages.user_message_id）
--   4. 按用户的生成限流函数（check_user_generation_rate）
--   5. 一致事务边界：原子建项目（create_project_with_conversation）与原子结果落库
--      （private.land_generation_result）
--
-- 全部为增量变更（仅新增列 / 表 / 函数），可安全叠加于已部署库（第 05 篇第八节、
-- 第 06 篇第四节与第九节）。
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) 内容安全：审核结果落库 + 可配置策略
-- ----------------------------------------------------------------------------

-- 在生成任务上记录审核结论与拦截原因，供审计与申诉（第 05 篇第八节）。
alter table public.generations
  add column if not exists moderation_status text not null default 'pending'
    check (moderation_status in ('pending', 'passed', 'blocked')),
  add column if not exists moderation_reason text;

comment on column public.generations.moderation_status is '内容安全审核状态：pending 未审 / passed 通过 / blocked 拦截。';
comment on column public.generations.moderation_reason is '审核拦截原因（命中策略词或产出被过滤），无则为空。';

-- 可配置的内容安全策略词表（替代硬编码黑名单，可按地区维护）。
create table if not exists public.moderation_policies (
  id uuid primary key default gen_random_uuid (),
  term text not null,
  match_type text not null default 'substring' check (match_type in ('substring', 'regex')),
  severity text not null default 'block' check (severity in ('block', 'warn')),
  locale text,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

comment on table public.moderation_policies is '内容安全策略：可配置违规词 / 正则，按地区维护；仅服务角色（Edge）读取。';

-- 仅服务角色读取（Edge 以 service_role 绕过 RLS）；客户端无任何访问。
alter table public.moderation_policies enable row level security;

-- 迁移既有硬编码黑名单为种子（幂等：重复执行不重复插入）。
insert into public.moderation_policies (term, match_type, severity)
select v.term, 'substring', 'block'
from (values ('child sexual'), ('cp porn'), ('儿童色情')) as v (term)
where not exists (
  select 1 from public.moderation_policies p where p.term = v.term
);

-- ----------------------------------------------------------------------------
-- 2) create-project 项目级幂等：客户端请求标识去重，重复不重建
-- ----------------------------------------------------------------------------
alter table public.projects
  add column if not exists client_request_id text;

comment on column public.projects.client_request_id is '客户端请求标识：用于连点去重，同一 owner 下重复请求复用既有项目而不重建。';

-- 同一用户内唯一；为空（多数历史行）不参与约束。
create unique index if not exists projects_owner_client_request_id_key
  on public.projects (owner_id, client_request_id)
  where client_request_id is not null;

-- ----------------------------------------------------------------------------
-- 3) agent-orchestrate 助手消息去重：把助手消息锚定到其回应的用户消息
-- ----------------------------------------------------------------------------
alter table public.messages
  add column if not exists user_message_id uuid references public.messages (id) on delete cascade;

comment on column public.messages.user_message_id is '该助手消息所回应的用户消息 id；用于编排幂等（同一用户消息只产生一条助手消息）。';

-- 一条用户消息至多对应一条助手消息（编排幂等的强约束）。
create unique index if not exists messages_assistant_per_user_idx
  on public.messages (user_message_id)
  where role = 'assistant' and user_message_id is not null;

-- ----------------------------------------------------------------------------
-- 4) 按用户的生成限流（第 06 篇第九节：滥用防护 → rate_limited）
--    统计该用户名下全部项目在窗口内创建的生成数；低于上限返回 true（放行）。
-- ----------------------------------------------------------------------------
create or replace function public.check_user_generation_rate(
  p_user_id uuid,
  p_window_secs integer default 60,
  p_max integer default 20
) returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select count(*) < p_max
    from public.generations g
    join public.projects p on p.id = g.project_id
   where p.owner_id = p_user_id
     and g.created_at > now() - make_interval(secs => p_window_secs);
$$;

comment on function public.check_user_generation_rate is '滑动窗口内该用户的生成数是否低于上限；用于按用户限流。';

revoke all on function public.check_user_generation_rate(uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.check_user_generation_rate(uuid, integer, integer) to service_role;

-- ----------------------------------------------------------------------------
-- 5a) 一致事务边界：原子创建「项目 + 会话 + 首条消息」，内建 client_request_id 幂等
--     （第 06 篇第四节 create-project：在一个一致的边界内创建；要么全成、要么全不成）
-- ----------------------------------------------------------------------------
create or replace function public.create_project_with_conversation(
  p_owner_id uuid,
  p_title text,
  p_scene text,
  p_model_key text,
  p_prompt text,
  p_mentions jsonb,
  p_attachments jsonb,
  p_client_request_id text
) returns table (project_id uuid, conversation_id uuid, message_id uuid, deduplicated boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project_id uuid;
  v_conversation_id uuid;
  v_message_id uuid;
begin
  -- 幂等命中：同一 owner + client_request_id 直接复用既有项目链路
  if p_client_request_id is not null then
    select pr.id into v_project_id
      from public.projects pr
     where pr.owner_id = p_owner_id and pr.client_request_id = p_client_request_id;
    if found then
      select c.id into v_conversation_id
        from public.conversations c where c.project_id = v_project_id
        order by c.created_at limit 1;
      select m.id into v_message_id
        from public.messages m
        where m.conversation_id = v_conversation_id and m.role = 'user'
        order by m.created_at limit 1;
      return query select v_project_id, v_conversation_id, v_message_id, true;
      return;
    end if;
  end if;

  insert into public.projects (owner_id, title, initial_scene, default_model_key, client_request_id, last_opened_at)
    values (p_owner_id, coalesce(p_title, 'Untitled'), p_scene, p_model_key, p_client_request_id, now())
    returning id into v_project_id;

  insert into public.conversations (project_id)
    values (v_project_id)
    returning id into v_conversation_id;

  insert into public.messages (conversation_id, role, content, model_key, mentions, attachments)
    values (
      v_conversation_id, 'user', p_prompt, p_model_key,
      coalesce(p_mentions, '[]'::jsonb), coalesce(p_attachments, '[]'::jsonb)
    )
    returning id into v_message_id;

  return query select v_project_id, v_conversation_id, v_message_id, false;
exception
  when unique_violation then
    -- 并发竞态：另一请求已用同一 client_request_id 建项目，复用之
    select pr.id into v_project_id
      from public.projects pr
     where pr.owner_id = p_owner_id and pr.client_request_id = p_client_request_id;
    select c.id into v_conversation_id
      from public.conversations c where c.project_id = v_project_id
      order by c.created_at limit 1;
    select m.id into v_message_id
      from public.messages m
      where m.conversation_id = v_conversation_id and m.role = 'user'
      order by m.created_at limit 1;
    return query select v_project_id, v_conversation_id, v_message_id, true;
end;
$$;

comment on function public.create_project_with_conversation is '原子创建项目 + 会话 + 首条用户消息，并按 client_request_id 去重；返回各 id 与是否命中幂等。';

revoke all on function public.create_project_with_conversation(uuid, text, text, text, text, jsonb, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.create_project_with_conversation(uuid, text, text, text, text, jsonb, jsonb, text)
  to service_role;

-- ----------------------------------------------------------------------------
-- 5b) 一致事务边界：原子结果落库（第 06 篇第四节完成阶段）
--     媒体已先行转存 Storage，本函数把「资产入库 + 占位转真实节点 + 余产出新建节点
--     + 任务置成功」收敛到单一事务，避免半落库导致画布与任务状态不一致。
--     入参均为 Edge 侧已构建好的 jsonb（节点 data 由 TS 构造），本函数只做原子写。
--     置于 public 模式以便 Edge 经 PostgREST rpc 调用，但仅授予服务角色执行。
-- ----------------------------------------------------------------------------
create or replace function public.land_generation_result(
  p_generation_id uuid,
  p_owner_id uuid,
  p_project_id uuid,
  p_placeholder_node_id uuid,
  p_assets jsonb,       -- [{id, kind, mimeType, storageBucket, storagePath, width, height, durationMs, sizeBytes, thumbnailPath}]
  p_first_node jsonb,   -- {type, assetId, data} 占位节点原地改写为真实节点；占位缺失时为 null
  p_extra_nodes jsonb,  -- [{type, positionX, positionY, width, height, assetId, data}]
  p_result_asset_id uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  a jsonb;
  n jsonb;
begin
  -- 1) 资产入库
  for a in select * from jsonb_array_elements(coalesce(p_assets, '[]'::jsonb)) loop
    insert into public.assets (
      id, owner_id, project_id, kind, source, generation_id,
      storage_bucket, storage_path, mime_type,
      width, height, duration_ms, size_bytes, thumbnail_path
    ) values (
      (a ->> 'id')::uuid, p_owner_id, p_project_id, (a ->> 'kind')::public.asset_kind, 'generation', p_generation_id,
      a ->> 'storageBucket', a ->> 'storagePath', a ->> 'mimeType',
      nullif(a ->> 'width', '')::integer, nullif(a ->> 'height', '')::integer,
      nullif(a ->> 'durationMs', '')::integer, nullif(a ->> 'sizeBytes', '')::bigint,
      nullif(a ->> 'thumbnailPath', '')
    );
  end loop;

  -- 2) 占位节点 → 真实节点（原地改写）
  if p_placeholder_node_id is not null and p_first_node is not null then
    update public.canvas_nodes
       set type = (p_first_node ->> 'type')::public.node_type,
           asset_id = (p_first_node ->> 'assetId')::uuid,
           generation_id = p_generation_id,
           data = coalesce(p_first_node -> 'data', '{}'::jsonb)
     where id = p_placeholder_node_id;
  end if;

  -- 3) 其余产出在占位附近新建节点
  for n in select * from jsonb_array_elements(coalesce(p_extra_nodes, '[]'::jsonb)) loop
    insert into public.canvas_nodes (
      project_id, type, position_x, position_y, width, height,
      rotation, z_index, data, asset_id, generation_id, created_by
    ) values (
      p_project_id, (n ->> 'type')::public.node_type,
      (n ->> 'positionX')::double precision, (n ->> 'positionY')::double precision,
      nullif(n ->> 'width', '')::double precision, nullif(n ->> 'height', '')::double precision,
      0, 0, coalesce(n -> 'data', '{}'::jsonb),
      (n ->> 'assetId')::uuid, p_generation_id, p_owner_id
    );
  end loop;

  -- 4) 任务置成功
  update public.generations
     set status = 'succeeded',
         progress = 100,
         result_asset_id = p_result_asset_id,
         error = null,
         moderation_status = 'passed',
         completed_at = now()
   where id = p_generation_id;
end;
$$;

comment on function public.land_generation_result is '在单一事务内完成结果落库：资产入库 + 占位转真实节点 + 余产出新建 + 任务置成功。';

revoke all on function public.land_generation_result(uuid, uuid, uuid, uuid, jsonb, jsonb, jsonb, uuid)
  from public, anon, authenticated;
grant execute on function public.land_generation_result(uuid, uuid, uuid, uuid, jsonb, jsonb, jsonb, uuid)
  to service_role;

-- ----------------------------------------------------------------------------
-- 6) 队列重试退避：设置某消息的可见性超时（用于瞬时失败的指数退避重试）
-- ----------------------------------------------------------------------------
create or replace function public.set_generation_job_vt(p_msg_id bigint, p_vt integer)
returns void
language plpgsql
security definer
set search_path = public, pgmq
as $$
begin
  perform pgmq.set_vt('generation_jobs', p_msg_id, p_vt);
end;
$$;

comment on function public.set_generation_job_vt is '设置待处理队列中某消息的可见性超时（秒），用于失败重试的退避调度。';

revoke all on function public.set_generation_job_vt(bigint, integer) from public, anon, authenticated;
grant execute on function public.set_generation_job_vt(bigint, integer) to service_role;

-- ----------------------------------------------------------------------------
-- 7) 项目缩略图：当画布出现绑定资产的图片 / 视频节点时，把该资产的存储引用写入
--    projects.thumbnail_url（存为 "bucket/path"，读取时由客户端 / 服务端签名）。
--    仅在 asset_id / type 变化时触发，避免位置 / 尺寸高频更新引发无谓写入。
-- ----------------------------------------------------------------------------
create or replace function public.set_project_thumbnail_from_node()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ref text;
begin
  if new.asset_id is null or new.type not in ('image', 'video') then
    return new;
  end if;
  select case
           when a.thumbnail_path is not null then a.storage_bucket || '/' || a.thumbnail_path
           else a.storage_bucket || '/' || a.storage_path
         end
    into v_ref
    from public.assets a
   where a.id = new.asset_id;
  if v_ref is not null then
    update public.projects set thumbnail_url = v_ref where id = new.project_id;
  end if;
  return new;
end;
$$;

comment on function public.set_project_thumbnail_from_node is '画布出现绑定资产的图片 / 视频节点时，把其存储引用写入项目缩略图字段。';

drop trigger if exists trg_set_project_thumbnail on public.canvas_nodes;
create trigger trg_set_project_thumbnail
  after insert or update of asset_id, type on public.canvas_nodes
  for each row
  execute function public.set_project_thumbnail_from_node();
