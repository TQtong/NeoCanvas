-- Flow Studio：允许把文本工作流输出幂等发布为普通 Canvas 文本节点。
create or replace function public.publish_workflow_outputs(
  p_requester_id uuid,
  p_run_id uuid,
  p_output_ids uuid[]
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run public.workflow_runs;
  v_output record;
  v_node_id uuid;
  v_node_type public.node_type;
  v_node_width double precision;
  v_node_height double precision;
  v_node_data jsonb;
  v_x double precision;
  v_y double precision := 80;
  v_node_ids jsonb := '[]'::jsonb;
begin
  select * into v_run from public.workflow_runs where id = p_run_id for update;
  if not found then raise exception using errcode = 'P0001', message = 'WORKFLOW_RUN_NOT_FOUND'; end if;
  if v_run.requester_id <> p_requester_id then
    raise exception using errcode = 'P0001', message = 'WORKFLOW_FORBIDDEN';
  end if;
  select coalesce(max(position_x + coalesce(width, 320)), 0) + 160 into v_x
    from public.canvas_nodes where project_id = v_run.project_id;

  for v_output in
    select o.*, a.kind, a.width as asset_width, a.height as asset_height
      from public.workflow_run_outputs o
      join public.workflow_run_nodes n on n.id = o.run_node_id
      left join public.assets a on a.id = o.asset_id
     where n.run_id = p_run_id and o.id = any(p_output_ids)
       and (
         (o.value_type = 'text' and o.asset_id is null)
         or (o.value_type in ('image_asset', 'video_asset') and a.id is not null)
       )
     order by o.ordinal, o.id
     for update of o
  loop
    if v_output.canvas_node_id is null then
      v_node_id := gen_random_uuid();
      if v_output.value_type = 'text' then
        v_node_type := 'text';
        v_node_width := 320;
        v_node_height := 120;
        v_node_data := jsonb_build_object(
          'text', coalesce(v_output.value #>> '{}', ''),
          'workflowLineage', jsonb_build_object(
            'workflowId', v_run.workflow_id, 'runId', v_run.id,
            'runNodeId', v_output.run_node_id, 'outputId', v_output.id
          )
        );
      else
        v_node_type := v_output.kind::text::public.node_type;
        v_node_width := least(coalesce(v_output.asset_width, 360), 480);
        v_node_height := least(coalesce(v_output.asset_height, 360), 480);
        v_node_data := jsonb_build_object(
          'role', 'primary',
          'workflowLineage', jsonb_build_object(
            'workflowId', v_run.workflow_id, 'runId', v_run.id,
            'runNodeId', v_output.run_node_id, 'outputId', v_output.id
          )
        );
      end if;

      insert into public.canvas_nodes (
        id, project_id, type, position_x, position_y, width, height,
        rotation, z_index, data, asset_id, created_by
      ) values (
        v_node_id, v_run.project_id, v_node_type, v_x, v_y,
        v_node_width, v_node_height, 0, 0, v_node_data,
        v_output.asset_id, p_requester_id
      );
      update public.workflow_run_outputs set canvas_node_id = v_node_id where id = v_output.id;
      v_y := v_y + v_node_height + 40;
    else
      v_node_id := v_output.canvas_node_id;
    end if;
    v_node_ids := v_node_ids || to_jsonb(v_node_id);
  end loop;
  return jsonb_build_object('nodeIds', v_node_ids);
end;
$$;

revoke all on function public.publish_workflow_outputs(uuid, uuid, uuid[])
  from public, anon, authenticated;
grant execute on function public.publish_workflow_outputs(uuid, uuid, uuid[]) to service_role;
