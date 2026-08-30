-- ============================================================================
-- 迁移 0032：候选采用并发门禁
--
-- 同一主节点与候选节点的两个并发采用请求不能排队后连续交换两次，否则用户会看到“成功”但
-- 最终内容回到原状。事务级 advisory lock 只拒绝真正重叠的请求；首次事务提交后，用户基于
-- 最新 Realtime 状态再次采用仍然允许，从而保留原内容可恢复能力。
-- ============================================================================

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
  v_lock_key bigint;
begin
  if p_geometry_mode not in ('preserve_frame', 'adopt_output_geometry') then
    raise exception using errcode = 'P0001', message = 'INVALID_CANDIDATE_GEOMETRY_MODE';
  end if;

  v_lock_key := hashtextextended(
    format(
      'candidate-adoption:%s:%s:%s',
      p_project_id,
      least(p_primary_node_id, p_candidate_node_id),
      greatest(p_primary_node_id, p_candidate_node_id)
    ),
    0
  );
  if not pg_try_advisory_xact_lock(v_lock_key) then
    raise exception using errcode = 'P0001', message = 'CANDIDATE_ADOPTION_CONFLICT';
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
  '按操作约束原子采用候选；重叠采用请求立即冲突，扩图采用输出几何并保持主节点中心。';

revoke all on function public.swap_media_candidate(uuid, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.swap_media_candidate(uuid, uuid, uuid, text)
  to service_role;
