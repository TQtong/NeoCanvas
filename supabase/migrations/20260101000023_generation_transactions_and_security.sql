-- ============================================================================
-- 迁移 0023：生成事务、并发门禁与暂存补偿
--
-- 采用“扩展后切换”：保留旧 RPC 供短期回滚，新写路径改用本迁移提供的原子提交、
-- 单次结果落库与终态门禁函数。所有管理员语义函数仅授予 service_role。
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) 幂等作用域、提供商任务唯一性、轮询租约与结果摘要
-- ----------------------------------------------------------------------------
alter table public.generations
  add column if not exists requester_id uuid references public.profiles (id) on delete cascade,
  add column if not exists operation_type text not null default 'generation',
  add column if not exists request_hash text,
  add column if not exists submission_queue_message_id bigint,
  add column if not exists provider_output_summary jsonb,
  add column if not exists webhook_secret_hash text,
  add column if not exists webhook_secret_expires_at timestamptz,
  add column if not exists poll_lease_token uuid,
  add column if not exists poll_lease_until timestamptz;

update public.generations g
   set requester_id = p.owner_id
  from public.projects p
 where g.project_id = p.id
   and g.requester_id is null;

alter table public.generations
  alter column requester_id set not null;

alter table public.generations
  drop constraint if exists generations_idempotency_key_key;

create unique index if not exists generations_scoped_idempotency_uidx
  on public.generations (requester_id, project_id, operation_type, idempotency_key)
  where idempotency_key is not null;

create unique index if not exists generations_provider_task_uidx
  on public.generations (provider, external_job_id)
  where external_job_id is not null;

create index if not exists generations_poll_lease_idx
  on public.generations (status, poll_lease_until, updated_at)
  where status = 'running' and external_job_id is not null;

comment on column public.generations.requester_id is
  '生成请求归属用户；与 project/operation/idempotency_key 共同限定幂等作用域。';
comment on column public.generations.request_hash is
  'Edge 对规范化请求计算的 SHA-256；用于识别同幂等键但语义不同的冲突请求。';
comment on column public.generations.submission_queue_message_id is
  '原子提交事务写入 generation_jobs 队列后返回的 pgmq 消息 id。';
comment on column public.generations.poll_lease_until is
  '异步任务轮询租约到期时间；配合 SKIP LOCKED 防止多个批次同时轮询。';

-- generation 与占位节点互相引用；原子事务先写任务、再写占位，提交时二者已完整存在。
alter table public.generations
  alter constraint generations_placeholder_node_id_fkey deferrable initially deferred;

create table if not exists public.generation_webhook_events (
  id uuid primary key default gen_random_uuid(),
  generation_id uuid not null references public.generations (id) on delete cascade,
  provider text not null,
  event_key text not null,
  received_at timestamptz not null default now(),
  unique (provider, event_key)
);

alter table public.generation_webhook_events enable row level security;
revoke all on table public.generation_webhook_events from public, anon, authenticated;
grant select, insert, update, delete on table public.generation_webhook_events to service_role;

comment on table public.generation_webhook_events is
  '已验证 Provider 回调的重放门禁；同 provider/event_key 只推进一次。';

-- ----------------------------------------------------------------------------
-- 2) Storage 暂存尝试账本。只记录任务专属 staging 前缀，补偿任务不得扫描正式目录。
-- ----------------------------------------------------------------------------
create table if not exists public.generation_output_attempts (
  id uuid primary key,
  generation_id uuid not null references public.generations (id) on delete cascade,
  owner_id uuid not null references public.profiles (id) on delete cascade,
  staging_prefix text not null check (staging_prefix like 'staging/%'),
  storage_bucket text not null default 'generations',
  object_paths jsonb not null default '[]'::jsonb check (jsonb_typeof(object_paths) = 'array'),
  status text not null default 'uploading'
    check (status in ('uploading', 'staged', 'committed', 'discarded', 'rpc_failed', 'cleaned')),
  cleanup_after timestamptz not null default (now() + interval '6 hours'),
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists generation_output_attempts_cleanup_idx
  on public.generation_output_attempts (cleanup_after)
  where status in ('uploading', 'staged', 'discarded', 'rpc_failed');

alter table public.generation_output_attempts enable row level security;
revoke all on table public.generation_output_attempts from public, anon, authenticated;
grant select, insert, update, delete on table public.generation_output_attempts to service_role;

comment on table public.generation_output_attempts is
  '生成结果的 Storage 暂存尝试账本；仅 service_role 可访问，过期未提交对象由补偿函数清理。';

-- ----------------------------------------------------------------------------
-- 3) 原子提交：任务、占位、候选关系、面板、队列在同一数据库事务内创建。
-- ----------------------------------------------------------------------------
create or replace function public.create_generation_submission(
  p_requester_id uuid,
  p_generation_id uuid,
  p_project_id uuid,
  p_conversation_id uuid,
  p_message_id uuid,
  p_modality public.modality,
  p_model_key text,
  p_prompt text,
  p_params jsonb,
  p_idempotency_key text,
  p_request_hash text,
  p_placeholder_node_id uuid,
  p_placement jsonb,
  p_target_node_id uuid default null,
  p_result_mode text default 'new_primary',
  p_operation_type text default 'generation',
  p_max_inflight integer default 8
) returns jsonb
language plpgsql
security definer
set search_path = public, pgmq
as $$
declare
  v_project public.projects;
  v_model public.model_catalog;
  v_generation public.generations;
  v_existing_node public.canvas_nodes;
  v_generation_id uuid;
  v_placeholder_id uuid;
  v_queue_message_id bigint;
  v_inserted boolean := false;
  v_preserved_data jsonb := '{}'::jsonb;
  v_node_ids jsonb;
  v_edge_ids jsonb;
begin
  if nullif(btrim(p_idempotency_key), '') is null or nullif(btrim(p_request_hash), '') is null then
    raise exception using errcode = 'P0001', message = 'INVALID_SUBMISSION_IDEMPOTENCY';
  end if;
  if p_result_mode not in ('new_primary', 'candidate_for_target') then
    raise exception using errcode = 'P0001', message = 'INVALID_RESULT_MODE';
  end if;

  -- 项目行锁同时串行化本项目的在途上限检查与新任务创建。
  select * into v_project
    from public.projects
   where id = p_project_id
   for update;
  if not found or v_project.is_deleted then
    raise exception using errcode = 'P0001', message = 'PROJECT_NOT_FOUND';
  end if;
  if v_project.owner_id <> p_requester_id then
    raise exception using errcode = 'P0001', message = 'PROJECT_FORBIDDEN';
  end if;

  select * into v_model
    from public.model_catalog
   where key = p_model_key
     and is_active
     and modality = p_modality
     and (user_id is null or user_id = p_requester_id)
   limit 1;
  if not found then
    raise exception using errcode = 'P0001', message = 'MODEL_NOT_ACCESSIBLE';
  end if;
  if v_model.provider like 'custom:%' and not exists (
    select 1
      from public.provider_credentials c
     where c.user_id = p_requester_id
       and c.provider = v_model.provider
       and c.enabled
  ) then
    raise exception using errcode = 'P0001', message = 'MODEL_CREDENTIAL_UNAVAILABLE';
  end if;

  if p_conversation_id is not null and not exists (
    select 1 from public.conversations c
     where c.id = p_conversation_id and c.project_id = p_project_id
  ) then
    raise exception using errcode = 'P0001', message = 'CONVERSATION_NOT_IN_PROJECT';
  end if;
  if p_message_id is not null and not exists (
    select 1 from public.messages m
    join public.conversations c on c.id = m.conversation_id
     where m.id = p_message_id and c.project_id = p_project_id
       and (p_conversation_id is null or c.id = p_conversation_id)
  ) then
    raise exception using errcode = 'P0001', message = 'MESSAGE_NOT_IN_CONVERSATION';
  end if;
  if p_result_mode = 'candidate_for_target' and (
    p_target_node_id is null or not exists (
      select 1 from public.canvas_nodes n
       where n.id = p_target_node_id
         and n.project_id = p_project_id
         and n.type in ('image', 'video')
    )
  ) then
    raise exception using errcode = 'P0001', message = 'TARGET_NODE_NOT_ACCESSIBLE';
  end if;

  select * into v_generation
    from public.generations
   where requester_id = p_requester_id
     and project_id = p_project_id
     and operation_type = p_operation_type
     and idempotency_key = p_idempotency_key
   for update;

  if found then
    if v_generation.request_hash is not null and v_generation.request_hash <> p_request_hash then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_CONFLICT';
    end if;
    if v_generation.conversation_id is distinct from p_conversation_id
       or v_generation.message_id is distinct from p_message_id
       or v_generation.modality <> p_modality
       or v_generation.model_key <> p_model_key
       or v_generation.prompt is distinct from p_prompt
       or v_generation.params <> coalesce(p_params, '{}'::jsonb) then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_CONFLICT';
    end if;
    v_generation_id := v_generation.id;
    v_placeholder_id := v_generation.placeholder_node_id;
    v_queue_message_id := v_generation.submission_queue_message_id;
    if v_generation.request_hash is null then
      update public.generations set request_hash = p_request_hash where id = v_generation_id;
    end if;
  else
    if (
      select count(*)
        from public.generations
       where project_id = p_project_id and status in ('pending', 'running')
    ) >= greatest(1, p_max_inflight) then
      raise exception using errcode = 'P0001', message = 'GENERATION_INFLIGHT_LIMIT';
    end if;

    v_generation_id := p_generation_id;
    v_placeholder_id := p_placeholder_node_id;
    insert into public.generations (
      id, requester_id, operation_type, request_hash,
      project_id, conversation_id, message_id, modality, model_key, provider,
      prompt, params, target_node_id, result_mode, status, progress,
      moderation_status, idempotency_key, placeholder_node_id
    ) values (
      v_generation_id, p_requester_id, p_operation_type, p_request_hash,
      p_project_id, p_conversation_id, p_message_id, p_modality, p_model_key, v_model.provider,
      p_prompt, coalesce(p_params, '{}'::jsonb), p_target_node_id, p_result_mode, 'pending', 0,
      'passed', p_idempotency_key, v_placeholder_id
    );
    v_inserted := true;

    select * into v_existing_node
      from public.canvas_nodes
     where id = v_placeholder_id
     for update;
    if found and v_existing_node.project_id <> p_project_id then
      raise exception using errcode = 'P0001', message = 'PLACEHOLDER_NODE_FORBIDDEN';
    end if;
    if found then
      v_preserved_data := jsonb_strip_nulls(jsonb_build_object(
        'groupId', v_existing_node.data -> 'groupId',
        'mediaDescription', v_existing_node.data -> 'mediaDescription',
        'generationSettings', v_existing_node.data -> 'generationSettings'
      ));
    end if;

    insert into public.canvas_nodes (
      id, project_id, type, position_x, position_y, width, height, rotation, z_index,
      parent_id, data, asset_id, generation_id, created_by
    ) values (
      v_placeholder_id, p_project_id, 'generation_placeholder',
      coalesce((p_placement ->> 'x')::double precision, 0),
      coalesce((p_placement ->> 'y')::double precision, 0),
      coalesce((p_placement ->> 'width')::double precision, 320),
      coalesce((p_placement ->> 'height')::double precision, 320),
      0, coalesce(v_existing_node.z_index, 0),
      coalesce(nullif(p_placement ->> 'parentId', '')::uuid, v_existing_node.parent_id),
      v_preserved_data || jsonb_strip_nulls(jsonb_build_object(
        'targetModality', case when p_modality = 'video' then 'video' else 'image' end,
        'promptSummary', left(coalesce(p_prompt, ''), 80),
        'targetWidth', coalesce((p_placement ->> 'width')::double precision, 320),
        'targetHeight', coalesce((p_placement ->> 'height')::double precision, 320),
        'targetNodeId', p_target_node_id,
        'resultMode', p_result_mode
      )),
      null, v_generation_id, p_requester_id
    )
    on conflict (id) do update set
      project_id = excluded.project_id,
      type = excluded.type,
      position_x = excluded.position_x,
      position_y = excluded.position_y,
      width = excluded.width,
      height = excluded.height,
      rotation = excluded.rotation,
      z_index = excluded.z_index,
      parent_id = excluded.parent_id,
      data = excluded.data,
      asset_id = null,
      generation_id = excluded.generation_id;

    if p_result_mode = 'candidate_for_target' then
      insert into public.canvas_edges (
        project_id, source_node_id, target_node_id, source_handle, target_handle, type, data
      ) values (
        p_project_id, p_target_node_id, v_placeholder_id,
        'media-candidate-out', 'media-candidate-in', 'media_candidate',
        jsonb_build_object('label', '候选', 'generationId', v_generation_id)
      );

      insert into public.canvas_nodes (
        project_id, type, position_x, position_y, width, height, rotation, z_index, data, created_by
      ) values (
        p_project_id, 'media_panel',
        coalesce((p_placement ->> 'x')::double precision, 0),
        coalesce((p_placement ->> 'y')::double precision, 0)
          + coalesce((p_placement ->> 'height')::double precision, 320) + 24,
        coalesce((p_placement ->> 'width')::double precision, 320),
        56, 0, coalesce(v_existing_node.z_index, 0) + 1,
        jsonb_build_object('targetNodeId', v_placeholder_id, 'collapsed', true),
        p_requester_id
      );
    end if;

    v_queue_message_id := public.enqueue_generation_job(v_generation_id);
    update public.generations
       set submission_queue_message_id = v_queue_message_id
     where id = v_generation_id;
  end if;

  -- 兼容旧写路径留下的完整 pending 行：首次由新 RPC 命中时补一次队列标识。
  if not v_inserted and v_queue_message_id is null and v_generation.status = 'pending' then
    v_queue_message_id := public.enqueue_generation_job(v_generation_id);
    update public.generations
       set submission_queue_message_id = v_queue_message_id
     where id = v_generation_id;
  end if;

  select coalesce(jsonb_agg(id order by id), '[]'::jsonb) into v_node_ids
    from public.canvas_nodes
   where id = v_placeholder_id
      or (project_id = p_project_id and type = 'media_panel' and data ->> 'targetNodeId' = v_placeholder_id::text);
  select coalesce(jsonb_agg(id order by id), '[]'::jsonb) into v_edge_ids
    from public.canvas_edges
   where project_id = p_project_id
     and target_node_id = v_placeholder_id
     and type = 'media_candidate';

  return jsonb_build_object(
    'generationId', v_generation_id,
    'placeholderNodeId', v_placeholder_id,
    'nodeIds', v_node_ids,
    'edgeIds', v_edge_ids,
    'queueMessageId', case when v_queue_message_id is null then null else v_queue_message_id::text end,
    'reused', not v_inserted
  );
end;
$$;

comment on function public.create_generation_submission is
  '原子创建生成任务、占位、候选关系/面板并写入持久队列；按用户/项目/操作/键严格幂等。';

revoke all on function public.create_generation_submission(
  uuid, uuid, uuid, uuid, uuid, public.modality, text, text, jsonb, text, text, uuid,
  jsonb, uuid, text, text, integer
) from public, anon, authenticated;
grant execute on function public.create_generation_submission(
  uuid, uuid, uuid, uuid, uuid, public.modality, text, text, jsonb, text, text, uuid,
  jsonb, uuid, text, text, integer
) to service_role;

-- ----------------------------------------------------------------------------
-- 4) 结果只落库一次：行锁 + 终态门禁 + 资产/节点/边/面板/终态单事务。
-- ----------------------------------------------------------------------------
create or replace function public.land_generation_result_once(
  p_generation_id uuid,
  p_owner_id uuid,
  p_project_id uuid,
  p_placeholder_node_id uuid,
  p_attempt_id uuid,
  p_assets jsonb,
  p_first_node jsonb,
  p_extra_nodes jsonb,
  p_result_asset_id uuid,
  p_provider_output_summary jsonb default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_generation public.generations;
  v_attempt public.generation_output_attempts;
  a jsonb;
  n jsonb;
  v_node_id uuid;
  v_candidate record;
  v_asset_ids jsonb;
  v_node_ids jsonb;
begin
  select * into v_generation
    from public.generations
   where id = p_generation_id
   for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'GENERATION_NOT_FOUND';
  end if;
  if v_generation.project_id <> p_project_id or v_generation.requester_id <> p_owner_id then
    raise exception using errcode = 'P0001', message = 'GENERATION_OWNERSHIP_MISMATCH';
  end if;
  if v_generation.placeholder_node_id is distinct from p_placeholder_node_id then
    raise exception using errcode = 'P0001', message = 'GENERATION_PLACEHOLDER_MISMATCH';
  end if;

  select * into v_attempt
    from public.generation_output_attempts
   where id = p_attempt_id
   for update;
  if not found or v_attempt.generation_id <> p_generation_id or v_attempt.owner_id <> p_owner_id then
    raise exception using errcode = 'P0001', message = 'GENERATION_ATTEMPT_MISMATCH';
  end if;

  if v_generation.status in ('succeeded', 'failed', 'cancelled') then
    update public.generation_output_attempts
       set status = 'discarded', updated_at = now()
     where id = p_attempt_id and status <> 'committed';
    return jsonb_build_object(
      'landed', false,
      'generationId', p_generation_id,
      'terminalStatus', v_generation.status,
      'assetIds', '[]'::jsonb,
      'nodeIds', '[]'::jsonb
    );
  end if;

  if exists (
    select 1
      from jsonb_array_elements(coalesce(p_assets, '[]'::jsonb)) item
     where item ->> 'storageBucket' <> v_attempt.storage_bucket
        or item ->> 'storagePath' not like v_attempt.staging_prefix || '%'
  ) then
    raise exception using errcode = 'P0001', message = 'INVALID_STAGING_OBJECT_PATH';
  end if;

  for a in select * from jsonb_array_elements(coalesce(p_assets, '[]'::jsonb)) loop
    insert into public.assets (
      id, owner_id, project_id, kind, source, generation_id,
      storage_bucket, storage_path, mime_type,
      width, height, duration_ms, size_bytes, thumbnail_path
    ) values (
      (a ->> 'id')::uuid, p_owner_id, p_project_id,
      (a ->> 'kind')::public.asset_kind, 'generation', p_generation_id,
      a ->> 'storageBucket', a ->> 'storagePath', a ->> 'mimeType',
      nullif(a ->> 'width', '')::integer, nullif(a ->> 'height', '')::integer,
      nullif(a ->> 'durationMs', '')::integer, nullif(a ->> 'sizeBytes', '')::bigint,
      nullif(a ->> 'thumbnailPath', '')
    );
  end loop;

  if p_placeholder_node_id is not null and p_first_node is not null then
    update public.canvas_nodes
       set type = (p_first_node ->> 'type')::public.node_type,
           asset_id = (p_first_node ->> 'assetId')::uuid,
           generation_id = p_generation_id,
           data = coalesce(p_first_node -> 'data', '{}'::jsonb)
     where id = p_placeholder_node_id and project_id = p_project_id;
    if not found then
      raise exception using errcode = 'P0001', message = 'GENERATION_PLACEHOLDER_MISSING';
    end if;
  end if;

  for n in select * from jsonb_array_elements(coalesce(p_extra_nodes, '[]'::jsonb)) loop
    v_node_id := coalesce(nullif(n ->> 'id', '')::uuid, gen_random_uuid());
    insert into public.canvas_nodes (
      id, project_id, type, position_x, position_y, width, height,
      rotation, z_index, data, asset_id, generation_id, created_by
    ) values (
      v_node_id, p_project_id, (n ->> 'type')::public.node_type,
      (n ->> 'positionX')::double precision, (n ->> 'positionY')::double precision,
      nullif(n ->> 'width', '')::double precision, nullif(n ->> 'height', '')::double precision,
      0, 0, coalesce(n -> 'data', '{}'::jsonb),
      (n ->> 'assetId')::uuid, p_generation_id, p_owner_id
    );
  end loop;

  -- 候选关系和折叠媒体面板都在同一事务内补齐，不允许在 Edge RPC 之后追加业务写。
  for v_candidate in
    select id, position_x, position_y, width, height, z_index, data ->> 'candidateOf' as candidate_of
      from public.canvas_nodes
     where project_id = p_project_id
       and generation_id = p_generation_id
       and nullif(data ->> 'candidateOf', '') is not null
  loop
    insert into public.canvas_edges (
      project_id, source_node_id, target_node_id, source_handle, target_handle, type, data
    )
    select p_project_id, v_candidate.candidate_of::uuid, v_candidate.id,
           'media-candidate-out', 'media-candidate-in', 'media_candidate',
           jsonb_build_object('label', '候选', 'generationId', p_generation_id)
     where not exists (
       select 1 from public.canvas_edges e
        where e.project_id = p_project_id
          and e.source_node_id = v_candidate.candidate_of::uuid
          and e.target_node_id = v_candidate.id
          and e.type = 'media_candidate'
     );

    insert into public.canvas_nodes (
      project_id, type, position_x, position_y, width, height, rotation, z_index, data, created_by
    )
    select p_project_id, 'media_panel', v_candidate.position_x,
           v_candidate.position_y + coalesce(v_candidate.height, 320) + 24,
           coalesce(v_candidate.width, 320), 56, 0, coalesce(v_candidate.z_index, 0) + 1,
           jsonb_build_object('targetNodeId', v_candidate.id, 'collapsed', true), p_owner_id
     where not exists (
       select 1 from public.canvas_nodes panel
        where panel.project_id = p_project_id
          and panel.type = 'media_panel'
          and panel.data ->> 'targetNodeId' = v_candidate.id::text
     );
  end loop;

  update public.generations
     set status = 'succeeded', progress = 100, result_asset_id = p_result_asset_id,
         provider_output_summary = p_provider_output_summary, error = null,
         moderation_status = 'passed', completed_at = now(),
         poll_lease_token = null, poll_lease_until = null
   where id = p_generation_id;

  update public.generation_output_attempts
     set status = 'committed', cleanup_after = 'infinity'::timestamptz,
         updated_at = now(), error = null
   where id = p_attempt_id;

  select coalesce(jsonb_agg(id order by id), '[]'::jsonb) into v_asset_ids
    from public.assets where generation_id = p_generation_id;
  select coalesce(jsonb_agg(id order by id), '[]'::jsonb) into v_node_ids
    from public.canvas_nodes where generation_id = p_generation_id;

  return jsonb_build_object(
    'landed', true,
    'generationId', p_generation_id,
    'terminalStatus', 'succeeded',
    'assetIds', v_asset_ids,
    'nodeIds', v_node_ids
  );
end;
$$;

comment on function public.land_generation_result_once is
  '锁定 generation 并只允许一个完成者原子写入资产、节点、候选边/面板和 succeeded 终态。';

revoke all on function public.land_generation_result_once(
  uuid, uuid, uuid, uuid, uuid, jsonb, jsonb, jsonb, uuid, jsonb
) from public, anon, authenticated;
grant execute on function public.land_generation_result_once(
  uuid, uuid, uuid, uuid, uuid, jsonb, jsonb, jsonb, uuid, jsonb
) to service_role;

-- ----------------------------------------------------------------------------
-- 5) 失败只提交一次；不能覆盖 succeeded/cancelled，也不能被迟到成功覆盖。
-- ----------------------------------------------------------------------------
create or replace function public.fail_generation_once(
  p_generation_id uuid,
  p_error text,
  p_moderation_reason text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_generation public.generations;
begin
  select * into v_generation
    from public.generations
   where id = p_generation_id
   for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'GENERATION_NOT_FOUND';
  end if;
  if v_generation.status in ('succeeded', 'failed', 'cancelled') then
    return jsonb_build_object(
      'changed', false,
      'generationId', p_generation_id,
      'terminalStatus', v_generation.status
    );
  end if;
  update public.generations
     set status = 'failed', error = p_error, completed_at = now(),
         moderation_status = case when p_moderation_reason is null then moderation_status else 'blocked' end,
         moderation_reason = coalesce(p_moderation_reason, moderation_reason),
         poll_lease_token = null, poll_lease_until = null
   where id = p_generation_id;
  return jsonb_build_object(
    'changed', true,
    'generationId', p_generation_id,
    'terminalStatus', 'failed'
  );
end;
$$;

revoke all on function public.fail_generation_once(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.fail_generation_once(uuid, text, text) to service_role;

-- ----------------------------------------------------------------------------
-- 6) 轮询批次以行锁认领租约，避免多个 cron 批次并发查询同一个付费任务。
-- ----------------------------------------------------------------------------
create or replace function public.claim_generation_poll_batch(
  p_qty integer default 20,
  p_lease_seconds integer default 120
) returns setof public.generations
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with candidates as (
    select id
      from public.generations
     where status = 'running'
       and external_job_id is not null
       and (poll_lease_until is null or poll_lease_until < now())
     order by updated_at asc
     for update skip locked
     limit least(greatest(p_qty, 1), 100)
  )
  update public.generations g
     set poll_lease_token = gen_random_uuid(),
         poll_lease_until = now() + make_interval(secs => least(greatest(p_lease_seconds, 30), 900))
    from candidates c
   where g.id = c.id
  returning g.*;
end;
$$;

create or replace function public.release_generation_poll_lease(
  p_generation_id uuid,
  p_lease_token uuid
) returns boolean
language sql
security definer
set search_path = public
as $$
  update public.generations
     set poll_lease_token = null, poll_lease_until = null
   where id = p_generation_id and poll_lease_token = p_lease_token
  returning true;
$$;

revoke all on function public.claim_generation_poll_batch(integer, integer)
  from public, anon, authenticated;
revoke all on function public.release_generation_poll_lease(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.claim_generation_poll_batch(integer, integer) to service_role;
grant execute on function public.release_generation_poll_lease(uuid, uuid) to service_role;

-- ----------------------------------------------------------------------------
-- 7) 暂存账本更新时间与清理认领。
-- ----------------------------------------------------------------------------
create trigger generation_output_attempts_set_updated_at
before update on public.generation_output_attempts
for each row execute function public.handle_updated_at();

create or replace function public.claim_stale_generation_output_attempts(p_qty integer default 50)
returns setof public.generation_output_attempts
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with candidates as (
    select id
      from public.generation_output_attempts
     where status in ('uploading', 'staged', 'discarded', 'rpc_failed')
       and cleanup_after < now()
     order by cleanup_after asc
     for update skip locked
     limit least(greatest(p_qty, 1), 200)
  )
  update public.generation_output_attempts a
     set cleanup_after = now() + interval '10 minutes'
    from candidates c
   where a.id = c.id
  returning a.*;
end;
$$;

revoke all on function public.claim_stale_generation_output_attempts(integer)
  from public, anon, authenticated;
grant execute on function public.claim_stale_generation_output_attempts(integer) to service_role;

-- 每 30 分钟清理一次已过安全窗口且未被结果事务提交的 staging 尝试。
select cron.schedule(
  'neocanvas-cleanup-generation-staging',
  '*/30 * * * *',
  $cron$ select private.invoke_edge_function('cleanup-generation-staging'); $cron$
);
