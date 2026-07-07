-- ============================================================================
-- 0018: 支持深层候选替换根主媒体
-- ============================================================================

create or replace function public.swap_media_candidate(
  p_project_id uuid,
  p_primary_node_id uuid,
  p_candidate_node_id uuid
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_primary public.canvas_nodes%rowtype;
  v_candidate public.canvas_nodes%rowtype;
  v_candidate_index integer;
  v_primary_data jsonb;
  v_candidate_data jsonb;
  v_cursor_id uuid;
  v_parent_id uuid;
  v_seen uuid[] := array[]::uuid[];
begin
  select * into v_primary
    from public.canvas_nodes
   where id = p_primary_node_id
     and project_id = p_project_id
     and type in ('image', 'video')
   for update;

  if not found then
    raise exception 'primary media node not found';
  end if;

  select * into v_candidate
    from public.canvas_nodes
   where id = p_candidate_node_id
     and project_id = p_project_id
     and type in ('image', 'video')
   for update;

  if not found then
    raise exception 'candidate media node not found';
  end if;

  if p_primary_node_id = p_candidate_node_id then
    raise exception 'candidate must differ from primary node';
  end if;

  v_cursor_id := p_candidate_node_id;
  loop
    if v_cursor_id = any(v_seen) then
      raise exception 'candidate ownership cycle detected';
    end if;
    v_seen := array_append(v_seen, v_cursor_id);

    select nullif(data ->> 'candidateOf', '')::uuid
      into v_parent_id
      from public.canvas_nodes
     where id = v_cursor_id
       and project_id = p_project_id
       and type in ('image', 'video');

    if v_parent_id is null then
      raise exception 'candidate does not belong to primary node';
    end if;
    exit when v_parent_id = p_primary_node_id;
    v_cursor_id := v_parent_id;
  end loop;

  v_candidate_index := nullif(v_candidate.data ->> 'candidateIndex', '')::integer;

  v_candidate_data :=
    (coalesce(v_candidate.data, '{}'::jsonb) - 'candidateOf' - 'candidateIndex')
    || jsonb_build_object('mediaRole', 'primary');

  v_primary_data :=
    (coalesce(v_primary.data, '{}'::jsonb) - 'candidateOf' - 'candidateIndex')
    || jsonb_build_object(
      'mediaRole', 'candidate',
      'candidateOf', p_primary_node_id::text,
      'candidateIndex', v_candidate_index
    );

  update public.canvas_nodes
     set type = v_candidate.type,
         asset_id = v_candidate.asset_id,
         generation_id = v_candidate.generation_id,
         data = v_candidate_data
   where id = p_primary_node_id;

  update public.canvas_nodes
     set type = v_primary.type,
         asset_id = v_primary.asset_id,
         generation_id = v_primary.generation_id,
         data = v_primary_data
   where id = p_candidate_node_id;

  update public.canvas_edges
     set source_node_id = p_primary_node_id,
         source_handle = 'media-candidate-out',
         target_handle = 'media-candidate-in',
         data = coalesce(data, '{}'::jsonb) || jsonb_build_object('label', '候选')
   where project_id = p_project_id
     and target_node_id = p_candidate_node_id
     and type = 'media_candidate';

  insert into public.canvas_edges (
    project_id,
    source_node_id,
    target_node_id,
    source_handle,
    target_handle,
    type,
    data
  )
  select
    p_project_id,
    p_primary_node_id,
    p_candidate_node_id,
    'media-candidate-out',
    'media-candidate-in',
    'media_candidate',
    jsonb_build_object('label', '候选')
  where not exists (
    select 1
      from public.canvas_edges
     where project_id = p_project_id
       and source_node_id = p_primary_node_id
       and target_node_id = p_candidate_node_id
       and type = 'media_candidate'
  );

  return true;
end;
$$;

comment on function public.swap_media_candidate is
  '原子替换主媒体与任意深层候选媒体：主节点 id 保持不变，旧主媒体留在候选节点中。';

revoke all on function public.swap_media_candidate(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.swap_media_candidate(uuid, uuid, uuid) to service_role;
