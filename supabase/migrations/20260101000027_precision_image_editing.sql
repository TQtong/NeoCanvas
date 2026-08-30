-- ============================================================================
-- 迁移 0027：精准图片编辑的数据基础
--
-- 1) 辅助资产不进入普通素材列表；
-- 2) generation_inputs 固化有序输入血缘并由 RLS 保护；
-- 3) 原子提交兼容重载在同一事务内写入 generation inputs；
-- 4) 候选采用兼容重载支持保留外框或采用扩图几何；
-- 5) 模型目录回填显式图片操作能力，旧模型不被乐观推断为支持精准编辑。
-- ============================================================================

alter table public.assets
  add column if not exists is_auxiliary boolean not null default false;

create index if not exists assets_project_auxiliary_created_idx
  on public.assets (project_id, is_auxiliary, created_at desc);

comment on column public.assets.is_auxiliary is
  '是否为蒙版、合并当前外观或按 Provider 上限生成的编辑输入；普通素材列表必须排除。';

create table if not exists public.generation_inputs (
  generation_id uuid not null references public.generations (id) on delete cascade,
  asset_id uuid not null references public.assets (id) on delete restrict,
  role text not null check (role in ('style', 'content', 'first_frame', 'mask', 'keyframe')),
  ordinal smallint not null check (ordinal >= 0),
  created_at timestamptz not null default now(),
  primary key (generation_id, ordinal)
);

create index if not exists generation_inputs_asset_idx
  on public.generation_inputs (asset_id);
create index if not exists generation_inputs_generation_role_idx
  on public.generation_inputs (generation_id, role);

alter table public.generation_inputs enable row level security;

drop policy if exists generation_inputs_select_own on public.generation_inputs;
create policy generation_inputs_select_own on public.generation_inputs
  for select to authenticated
  using (
    exists (
      select 1
        from public.generations g
       where g.id = generation_inputs.generation_id
         and g.requester_id = auth.uid()
    )
  );

revoke all on table public.generation_inputs from public, anon, authenticated;
grant select on table public.generation_inputs to authenticated;
grant select, insert, update, delete on table public.generation_inputs to service_role;

comment on table public.generation_inputs is
  '生成任务经过所有权验证后的有序输入资产；用于审计、确定性重试和 Provider 请求重建。';

update public.model_catalog
   set capabilities = capabilities || jsonb_build_object(
     'imageOperations',
     case
       when modality <> 'image' then '[]'::jsonb
       when coalesce((capabilities ->> 'supportsReferenceImages')::boolean, false)
         and provider in ('openai', 'google', 'siliconflow', 'minimax', 'jimeng', 'fal', 'replicate')
         then '["generate", "semantic_edit"]'::jsonb
       else '["generate"]'::jsonb
     end
   )
 where not (capabilities ? 'imageOperations');

update public.model_catalog
   set capabilities = capabilities || jsonb_build_object(
     'maxInputImages', 1,
     'inputFidelityOptions',
       case when provider = 'openai' then '["standard", "high"]'::jsonb else '[]'::jsonb end,
     'upscaleFactors', '[]'::jsonb,
     'supportsTransparentOutput', provider = 'openai',
     'maxInputPixels', 16777216
   )
 where modality = 'image';

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
  p_inputs jsonb,
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
  v_result jsonb;
  v_generation_id uuid;
  v_input jsonb;
  v_asset public.assets;
  v_asset_id uuid;
  v_expected_count integer;
begin
  if jsonb_typeof(coalesce(p_inputs, '[]'::jsonb)) <> 'array' then
    raise exception using errcode = 'P0001', message = 'INVALID_GENERATION_INPUTS';
  end if;

  for v_input in
    select value
      from jsonb_array_elements(coalesce(p_inputs, '[]'::jsonb))
  loop
    if nullif(v_input ->> 'assetId', '') is null
       or coalesce(v_input ->> 'role', '') not in
         ('style', 'content', 'first_frame', 'mask', 'keyframe') then
      raise exception using errcode = 'P0001', message = 'INVALID_GENERATION_INPUT';
    end if;

    begin
      v_asset_id := (v_input ->> 'assetId')::uuid;
    exception when invalid_text_representation then
      raise exception using errcode = 'P0001', message = 'INVALID_GENERATION_INPUT';
    end;

    select * into v_asset
      from public.assets
     where id = v_asset_id;
    if not found
       or v_asset.owner_id <> p_requester_id
       or v_asset.project_id is distinct from p_project_id then
      raise exception using errcode = 'P0001', message = 'GENERATION_INPUT_FORBIDDEN';
    end if;
  end loop;

  -- 旧签名仍在调用者事务中；后续输入写入失败会把任务、占位和队列一并回滚。
  v_result := public.create_generation_submission(
    p_requester_id,
    p_generation_id,
    p_project_id,
    p_conversation_id,
    p_message_id,
    p_modality,
    p_model_key,
    p_prompt,
    p_params,
    p_idempotency_key,
    p_request_hash,
    p_placeholder_node_id,
    p_placement,
    p_target_node_id,
    p_result_mode,
    p_operation_type,
    p_max_inflight
  );

  v_generation_id := (v_result ->> 'generationId')::uuid;
  insert into public.generation_inputs (generation_id, asset_id, role, ordinal)
  select
    v_generation_id,
    (value ->> 'assetId')::uuid,
    value ->> 'role',
    (ordinality - 1)::smallint
  from jsonb_array_elements(coalesce(p_inputs, '[]'::jsonb)) with ordinality
  on conflict (generation_id, ordinal) do nothing;

  v_expected_count := jsonb_array_length(coalesce(p_inputs, '[]'::jsonb));
  if (select count(*) from public.generation_inputs where generation_id = v_generation_id)
       <> v_expected_count
     or exists (
       select 1
         from jsonb_array_elements(coalesce(p_inputs, '[]'::jsonb)) with ordinality expected
         left join public.generation_inputs actual
           on actual.generation_id = v_generation_id
          and actual.ordinal = (expected.ordinality - 1)::smallint
          and actual.asset_id = (expected.value ->> 'assetId')::uuid
          and actual.role = expected.value ->> 'role'
        where actual.generation_id is null
     ) then
    raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_CONFLICT';
  end if;

  return v_result;
end;
$$;

comment on function public.create_generation_submission(
  uuid, uuid, uuid, uuid, uuid, public.modality, text, text, jsonb, text, text, uuid,
  jsonb, jsonb, uuid, text, text, integer
) is '兼容原子提交：在任务、占位和队列之外写入经过所有权校验的有序生成输入。';

revoke all on function public.create_generation_submission(
  uuid, uuid, uuid, uuid, uuid, public.modality, text, text, jsonb, text, text, uuid,
  jsonb, jsonb, uuid, text, text, integer
) from public, anon, authenticated;
grant execute on function public.create_generation_submission(
  uuid, uuid, uuid, uuid, uuid, public.modality, text, text, jsonb, text, text, uuid,
  jsonb, jsonb, uuid, text, text, integer
) to service_role;

create or replace function public.swap_media_candidate(
  p_project_id uuid,
  p_primary_node_id uuid,
  p_candidate_node_id uuid,
  p_geometry_mode text
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_primary public.canvas_nodes;
  v_candidate public.canvas_nodes;
  v_operation_type text;
  v_primary_center_x double precision;
  v_primary_center_y double precision;
  v_swapped boolean;
begin
  if p_geometry_mode not in ('preserve_frame', 'adopt_output_geometry') then
    raise exception using errcode = 'P0001', message = 'INVALID_CANDIDATE_GEOMETRY_MODE';
  end if;

  select * into v_primary
    from public.canvas_nodes
   where id = p_primary_node_id
     and project_id = p_project_id
     and type in ('image', 'video')
   for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'PRIMARY_MEDIA_NOT_FOUND';
  end if;

  select * into v_candidate
    from public.canvas_nodes
   where id = p_candidate_node_id
     and project_id = p_project_id
     and type in ('image', 'video')
   for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'CANDIDATE_MEDIA_NOT_FOUND';
  end if;

  select operation_type into v_operation_type
    from public.generations
   where id = v_candidate.generation_id;

  if p_geometry_mode = 'adopt_output_geometry'
     and v_operation_type is distinct from 'image:outpaint' then
    raise exception using errcode = 'P0001', message = 'CANDIDATE_GEOMETRY_OPERATION_MISMATCH';
  end if;
  if p_geometry_mode = 'preserve_frame'
     and v_operation_type = 'image:outpaint' then
    raise exception using errcode = 'P0001', message = 'CANDIDATE_GEOMETRY_OPERATION_MISMATCH';
  end if;
  if p_geometry_mode = 'adopt_output_geometry'
     and (
       coalesce(v_primary.width, 0) <= 0
       or coalesce(v_primary.height, 0) <= 0
       or coalesce(v_candidate.width, 0) <= 0
       or coalesce(v_candidate.height, 0) <= 0
     ) then
    raise exception using errcode = 'P0001', message = 'CANDIDATE_GEOMETRY_INVALID';
  end if;

  v_primary_center_x := v_primary.position_x + coalesce(v_primary.width, 0) / 2.0;
  v_primary_center_y := v_primary.position_y + coalesce(v_primary.height, 0) / 2.0;

  v_swapped := public.swap_media_candidate(
    p_project_id,
    p_primary_node_id,
    p_candidate_node_id
  );

  if p_geometry_mode = 'adopt_output_geometry' then
    update public.canvas_nodes
       set position_x = v_primary_center_x - v_candidate.width / 2.0,
           position_y = v_primary_center_y - v_candidate.height / 2.0,
           width = v_candidate.width,
           height = v_candidate.height
     where id = p_primary_node_id;

    update public.canvas_nodes
       set position_x = v_primary.position_x,
           position_y = v_primary.position_y,
           width = v_primary.width,
           height = v_primary.height
     where id = p_candidate_node_id;
  end if;

  return v_swapped;
end;
$$;

comment on function public.swap_media_candidate(uuid, uuid, uuid, text) is
  '按操作约束原子采用候选：普通编辑保留主外框，扩图采用候选宽高并保持主节点中心。';

revoke all on function public.swap_media_candidate(uuid, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.swap_media_candidate(uuid, uuid, uuid, text)
  to service_role;
