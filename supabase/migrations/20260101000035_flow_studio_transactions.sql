-- ============================================================================
-- 迁移 0035：Flow Studio 原子修订、运行、生成落库、Patch 与 Canvas 发布
-- ============================================================================

create or replace function public.create_workflow_run(
  p_requester_id uuid,
  p_run_id uuid,
  p_workflow_id uuid,
  p_expected_graph_revision bigint,
  p_graph_hash text,
  p_run_mode text,
  p_target_node_id uuid,
  p_force_rerun boolean,
  p_idempotency_key text,
  p_request_hash text,
  p_planned_node_ids uuid[]
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_workflow public.workflows;
  v_existing public.workflow_runs;
  v_revision_id uuid;
  v_run_node record;
  v_config jsonb;
  v_asset_text text;
begin
  if p_run_mode not in ('node', 'downstream', 'all')
     or nullif(btrim(p_idempotency_key), '') is null
     or nullif(btrim(p_request_hash), '') is null
     or coalesce(array_length(p_planned_node_ids, 1), 0) = 0 then
    raise exception using errcode = 'P0001', message = 'INVALID_WORKFLOW_RUN_REQUEST';
  end if;

  select * into v_workflow from public.workflows
   where id = p_workflow_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'WORKFLOW_NOT_FOUND';
  end if;
  if v_workflow.owner_id <> p_requester_id then
    raise exception using errcode = 'P0001', message = 'WORKFLOW_FORBIDDEN';
  end if;
  if v_workflow.graph_revision <> p_expected_graph_revision then
    raise exception using errcode = 'P0001', message = 'WORKFLOW_REVISION_CONFLICT';
  end if;
  if exists (
    select 1 from unnest(p_planned_node_ids) id
     where not exists (
       select 1 from public.workflow_nodes n
        where n.id = id and n.workflow_id = p_workflow_id
     )
  ) then
    raise exception using errcode = 'P0001', message = 'WORKFLOW_PLAN_INVALID';
  end if;

  select * into v_existing from public.workflow_runs
   where requester_id = p_requester_id and workflow_id = p_workflow_id
     and idempotency_key = p_idempotency_key
   for update;
  if found then
    if v_existing.request_hash <> p_request_hash then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_CONFLICT';
    end if;
    return jsonb_build_object(
      'runId', v_existing.id,
      'revisionId', v_existing.revision_id,
      'status', v_existing.status,
      'deduplicated', true
    );
  end if;

  select id into v_revision_id from public.workflow_revisions
   where workflow_id = p_workflow_id and revision_no = v_workflow.graph_revision;
  if v_revision_id is null then
    insert into public.workflow_revisions (
      workflow_id, revision_no, graph_hash, created_by
    ) values (
      p_workflow_id, v_workflow.graph_revision, p_graph_hash, p_requester_id
    ) returning id into v_revision_id;

    insert into public.workflow_revision_nodes (
      revision_id, node_id, kind, position_x, position_y, config, schema_version
    )
    select v_revision_id, id, kind, position_x, position_y, config, schema_version
      from public.workflow_nodes where workflow_id = p_workflow_id;

    insert into public.workflow_revision_edges (
      revision_id, edge_id, source_node_id, source_port,
      target_node_id, target_port, value_type
    )
    select v_revision_id, id, source_node_id, source_port,
           target_node_id, target_port, value_type
      from public.workflow_edges where workflow_id = p_workflow_id;

    for v_run_node in
      select id, config from public.workflow_nodes where workflow_id = p_workflow_id
    loop
      v_config := v_run_node.config;
      v_asset_text := nullif(v_config ->> 'assetId', '');
      if v_asset_text is not null then
        insert into public.workflow_revision_asset_refs (
          revision_id, node_id, asset_id, role, ordinal
        ) values (
          v_revision_id, v_run_node.id, v_asset_text::uuid, 'input', 0
        );
      end if;
      insert into public.workflow_revision_asset_refs (
        revision_id, node_id, asset_id, role, ordinal
      )
      select v_revision_id, v_run_node.id, value::text::uuid, 'collection', ordinality - 1
        from jsonb_array_elements_text(coalesce(v_config -> 'assetIds', '[]'::jsonb))
             with ordinality
      on conflict do nothing;
    end loop;
  end if;

  insert into public.workflow_runs (
    id, workflow_id, revision_id, project_id, requester_id, status,
    run_mode, target_node_id, force_rerun, idempotency_key, request_hash, started_at
  ) values (
    p_run_id, p_workflow_id, v_revision_id, v_workflow.project_id, p_requester_id, 'queued',
    p_run_mode, p_target_node_id, coalesce(p_force_rerun, false),
    p_idempotency_key, p_request_hash, now()
  );

  insert into public.workflow_run_nodes (
    run_id, workflow_node_id, kind, status, config_snapshot, model_key, executor_version
  )
  select p_run_id, n.node_id, n.kind,
         case when n.kind = 'note' then 'skipped'::public.workflow_run_node_status
              else 'pending'::public.workflow_run_node_status end,
         n.config, nullif(n.config ->> 'modelKey', ''), '1'
    from public.workflow_revision_nodes n
   where n.revision_id = v_revision_id and n.node_id = any(p_planned_node_ids);

  insert into public.workflow_run_input_links (
    run_id, source_run_node_id, source_port, target_run_node_id, target_port, ordinal
  )
  select p_run_id, source_run.id, e.source_port, target_run.id, e.target_port,
         row_number() over (
           partition by target_run.id, e.target_port order by e.edge_id
         ) - 1
    from public.workflow_revision_edges e
    join public.workflow_run_nodes source_run
      on source_run.run_id = p_run_id and source_run.workflow_node_id = e.source_node_id
    join public.workflow_run_nodes target_run
      on target_run.run_id = p_run_id and target_run.workflow_node_id = e.target_node_id
   where e.revision_id = v_revision_id;

  return jsonb_build_object(
    'runId', p_run_id,
    'revisionId', v_revision_id,
    'status', 'queued',
    'deduplicated', false
  );
end;
$$;

revoke all on function public.create_workflow_run(
  uuid, uuid, uuid, bigint, text, text, uuid, boolean, text, text, uuid[]
) from public, anon, authenticated;
grant execute on function public.create_workflow_run(
  uuid, uuid, uuid, bigint, text, text, uuid, boolean, text, text, uuid[]
) to service_role;

create or replace function public.create_workflow_generation_submission(
  p_requester_id uuid,
  p_generation_id uuid,
  p_run_node_id uuid,
  p_modality public.modality,
  p_model_key text,
  p_prompt text,
  p_params jsonb,
  p_idempotency_key text,
  p_request_hash text,
  p_inputs jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, pgmq
as $$
declare
  v_run_node public.workflow_run_nodes;
  v_run public.workflow_runs;
  v_model public.model_catalog;
  v_existing public.generations;
  v_queue_message_id bigint;
  v_input jsonb;
begin
  select * into v_run_node from public.workflow_run_nodes
   where id = p_run_node_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'WORKFLOW_RUN_NODE_NOT_FOUND';
  end if;
  select * into v_run from public.workflow_runs where id = v_run_node.run_id for update;
  if v_run.requester_id <> p_requester_id then
    raise exception using errcode = 'P0001', message = 'WORKFLOW_FORBIDDEN';
  end if;
  if v_run.status = 'cancelled' then
    raise exception using errcode = 'P0001', message = 'WORKFLOW_RUN_CANCELLED';
  end if;

  select * into v_model from public.model_catalog
   where key = p_model_key and is_active and modality = p_modality
     and (user_id is null or user_id = p_requester_id)
   limit 1;
  if not found then
    raise exception using errcode = 'P0001', message = 'MODEL_NOT_ACCESSIBLE';
  end if;

  select * into v_existing from public.generations
   where requester_id = p_requester_id and project_id = v_run.project_id
     and operation_type = 'workflow' and idempotency_key = p_idempotency_key
   for update;
  if found then
    if v_existing.request_hash <> p_request_hash then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_CONFLICT';
    end if;
    return jsonb_build_object(
      'generationId', v_existing.id,
      'queueMessageId', case when v_existing.submission_queue_message_id is null
        then null else v_existing.submission_queue_message_id::text end,
      'reused', true
    );
  end if;

  insert into public.generations (
    id, requester_id, operation_type, request_hash, project_id, modality,
    model_key, provider, prompt, params, result_mode, workflow_run_node_id,
    status, progress, moderation_status, idempotency_key
  ) values (
    p_generation_id, p_requester_id, 'workflow', p_request_hash, v_run.project_id, p_modality,
    p_model_key, v_model.provider, p_prompt, coalesce(p_params, '{}'::jsonb),
    'workflow_output', p_run_node_id, 'pending', 0, 'passed', p_idempotency_key
  );

  for v_input in select * from jsonb_array_elements(coalesce(p_inputs, '[]'::jsonb)) loop
    if not exists (
      select 1 from public.assets a
       where a.id = (v_input ->> 'assetId')::uuid and a.owner_id = p_requester_id
         and (a.project_id is null or a.project_id = v_run.project_id)
    ) then
      raise exception using errcode = 'P0001', message = 'GENERATION_INPUT_FORBIDDEN';
    end if;
    insert into public.generation_inputs(generation_id, asset_id, role, ordinal)
    values (
      p_generation_id, (v_input ->> 'assetId')::uuid,
      v_input ->> 'role', coalesce((v_input ->> 'ordinal')::integer, 0)
    );
  end loop;

  v_queue_message_id := public.enqueue_generation_job(p_generation_id);
  update public.generations set submission_queue_message_id = v_queue_message_id
   where id = p_generation_id;
  update public.workflow_run_nodes
     set status = 'waiting_generation', model_key = p_model_key,
         provider = v_model.provider, resolved_provider_model = v_model.key,
         started_at = coalesce(started_at, now()), error = null
   where id = p_run_node_id;
  update public.workflow_runs set status = 'running', started_at = coalesce(started_at, now())
   where id = v_run.id and status in ('queued', 'running');

  return jsonb_build_object(
    'generationId', p_generation_id,
    'queueMessageId', v_queue_message_id::text,
    'reused', false
  );
end;
$$;

revoke all on function public.create_workflow_generation_submission(
  uuid, uuid, uuid, public.modality, text, text, jsonb, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.create_workflow_generation_submission(
  uuid, uuid, uuid, public.modality, text, text, jsonb, text, text, jsonb
) to service_role;

create or replace function public.land_workflow_generation_result_once(
  p_generation_id uuid,
  p_owner_id uuid,
  p_project_id uuid,
  p_attempt_id uuid,
  p_assets jsonb,
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
  v_run_node public.workflow_run_nodes;
  a jsonb;
  v_ordinal integer := 0;
  v_port text;
  v_value_type public.flow_value_type;
  v_asset_ids jsonb;
begin
  select * into v_generation from public.generations
   where id = p_generation_id for update;
  if not found or v_generation.result_mode <> 'workflow_output'
     or v_generation.workflow_run_node_id is null then
    raise exception using errcode = 'P0001', message = 'WORKFLOW_GENERATION_NOT_FOUND';
  end if;
  if v_generation.project_id <> p_project_id or v_generation.requester_id <> p_owner_id then
    raise exception using errcode = 'P0001', message = 'GENERATION_OWNERSHIP_MISMATCH';
  end if;

  select * into v_attempt from public.generation_output_attempts
   where id = p_attempt_id for update;
  if not found or v_attempt.generation_id <> p_generation_id or v_attempt.owner_id <> p_owner_id then
    raise exception using errcode = 'P0001', message = 'GENERATION_ATTEMPT_MISMATCH';
  end if;
  if v_generation.status in ('succeeded', 'failed', 'cancelled') then
    update public.generation_output_attempts set status = 'discarded', updated_at = now()
     where id = p_attempt_id and status <> 'committed';
    return jsonb_build_object(
      'landed', false, 'generationId', p_generation_id,
      'terminalStatus', v_generation.status, 'assetIds', '[]'::jsonb, 'nodeIds', '[]'::jsonb
    );
  end if;
  if exists (
    select 1 from jsonb_array_elements(coalesce(p_assets, '[]'::jsonb)) item
     where item ->> 'storageBucket' <> v_attempt.storage_bucket
        or item ->> 'storagePath' not like v_attempt.staging_prefix || '%'
  ) then
    raise exception using errcode = 'P0001', message = 'INVALID_STAGING_OBJECT_PATH';
  end if;

  select * into v_run_node from public.workflow_run_nodes
   where id = v_generation.workflow_run_node_id for update;
  v_port := case
    when v_generation.modality = 'video' then 'video'
    when v_run_node.kind in ('image_upscale', 'image_remove_background') then 'image'
    else 'images'
  end;
  v_value_type := case
    when v_generation.modality = 'video' then 'video_asset'::public.flow_value_type
    when v_run_node.kind in ('image_upscale', 'image_remove_background')
      then 'image_asset'::public.flow_value_type
    else 'image_list'::public.flow_value_type
  end;

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
    insert into public.workflow_run_outputs (
      run_node_id, port_id, value_type, asset_id, value, ordinal
    ) values (
      v_run_node.id, v_port, v_value_type, (a ->> 'id')::uuid, null, v_ordinal
    );
    v_ordinal := v_ordinal + 1;
  end loop;

  update public.generations set
    status = 'succeeded', progress = 100, result_asset_id = p_result_asset_id,
    provider_output_summary = p_provider_output_summary, error = null,
    moderation_status = 'passed', completed_at = now(),
    poll_lease_token = null, poll_lease_until = null
   where id = p_generation_id;
  update public.workflow_run_nodes set
    status = 'succeeded', completed_at = now(), error = null
   where id = v_run_node.id;
  update public.generation_output_attempts set
    status = 'committed', cleanup_after = 'infinity'::timestamptz,
    updated_at = now(), error = null
   where id = p_attempt_id;

  select coalesce(jsonb_agg(id order by id), '[]'::jsonb) into v_asset_ids
    from public.assets where generation_id = p_generation_id;
  return jsonb_build_object(
    'landed', true, 'generationId', p_generation_id, 'terminalStatus', 'succeeded',
    'assetIds', v_asset_ids, 'nodeIds', '[]'::jsonb
  );
end;
$$;

revoke all on function public.land_workflow_generation_result_once(
  uuid, uuid, uuid, uuid, jsonb, uuid, jsonb
) from public, anon, authenticated;
grant execute on function public.land_workflow_generation_result_once(
  uuid, uuid, uuid, uuid, jsonb, uuid, jsonb
) to service_role;

create or replace function public.sync_workflow_generation_failure()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.workflow_run_node_id is not null
     and new.status in ('failed', 'cancelled')
     and old.status is distinct from new.status then
    update public.workflow_run_nodes set
      status = case when new.status = 'cancelled'
        then 'cancelled'::public.workflow_run_node_status
        else 'failed'::public.workflow_run_node_status end,
      error = new.error, completed_at = now()
     where id = new.workflow_run_node_id
       and status not in ('succeeded', 'cached', 'failed', 'cancelled');
  end if;
  return new;
end;
$$;

create trigger generations_sync_workflow_failure
  after update of status on public.generations
  for each row execute function public.sync_workflow_generation_failure();

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
      join public.assets a on a.id = o.asset_id
     where n.run_id = p_run_id and o.id = any(p_output_ids)
     order by o.ordinal, o.id
     for update of o
  loop
    if v_output.canvas_node_id is null then
      v_node_id := gen_random_uuid();
      insert into public.canvas_nodes (
        id, project_id, type, position_x, position_y, width, height,
        rotation, z_index, data, asset_id, created_by
      ) values (
        v_node_id, v_run.project_id, v_output.kind::text::public.node_type,
        v_x, v_y, least(coalesce(v_output.asset_width, 360), 480),
        least(coalesce(v_output.asset_height, 360), 480), 0, 0,
        jsonb_build_object(
          'role', 'primary', 'workflowLineage', jsonb_build_object(
            'workflowId', v_run.workflow_id, 'runId', v_run.id,
            'runNodeId', v_output.run_node_id, 'outputId', v_output.id
          )
        ), v_output.asset_id, p_requester_id
      );
      update public.workflow_run_outputs set canvas_node_id = v_node_id where id = v_output.id;
      v_y := v_y + least(coalesce(v_output.asset_height, 360), 480) + 40;
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

create or replace function public.apply_workflow_patch(
  p_requester_id uuid,
  p_proposal_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_proposal public.workflow_patch_proposals;
  v_workflow public.workflows;
  v_op jsonb;
begin
  select * into v_proposal from public.workflow_patch_proposals
   where id = p_proposal_id for update;
  if not found then raise exception using errcode = 'P0001', message = 'PROPOSAL_NOT_FOUND'; end if;
  select * into v_workflow from public.workflows where id = v_proposal.workflow_id for update;
  if v_proposal.requested_by <> p_requester_id or v_workflow.owner_id <> p_requester_id then
    raise exception using errcode = 'P0001', message = 'WORKFLOW_FORBIDDEN';
  end if;
  if v_proposal.status <> 'pending' then
    raise exception using errcode = 'P0001', message = 'PROPOSAL_TERMINAL';
  end if;
  if v_proposal.expires_at <= now() then
    update public.workflow_patch_proposals set status = 'expired', resolved_at = now()
     where id = v_proposal.id;
    raise exception using errcode = 'P0001', message = 'PROPOSAL_EXPIRED';
  end if;
  if v_workflow.graph_revision <> v_proposal.base_graph_revision then
    raise exception using errcode = 'P0001', message = 'WORKFLOW_REVISION_CONFLICT';
  end if;

  for v_op in select * from jsonb_array_elements(v_proposal.operations) loop
    case v_op ->> 'op'
      when 'add_node' then
        insert into public.workflow_nodes (
          id, workflow_id, kind, position_x, position_y, config, schema_version
        ) values (
          (v_op #>> '{node,id}')::uuid, v_workflow.id,
          (v_op #>> '{node,kind}')::public.workflow_node_kind,
          (v_op #>> '{node,position,x}')::double precision,
          (v_op #>> '{node,position,y}')::double precision,
          coalesce(v_op #> '{node,config}', '{}'::jsonb),
          coalesce((v_op #>> '{node,schemaVersion}')::integer, 1)
        );
      when 'update_node_config' then
        update public.workflow_nodes set config = coalesce(v_op -> 'config', '{}'::jsonb)
         where id = (v_op ->> 'nodeId')::uuid and workflow_id = v_workflow.id;
        if not found then raise exception using errcode = 'P0001', message = 'PATCH_NODE_NOT_FOUND'; end if;
      when 'move_node' then
        update public.workflow_nodes set
          position_x = (v_op #>> '{position,x}')::double precision,
          position_y = (v_op #>> '{position,y}')::double precision
         where id = (v_op ->> 'nodeId')::uuid and workflow_id = v_workflow.id;
        if not found then raise exception using errcode = 'P0001', message = 'PATCH_NODE_NOT_FOUND'; end if;
      when 'remove_node' then
        delete from public.workflow_nodes
         where id = (v_op ->> 'nodeId')::uuid and workflow_id = v_workflow.id;
      when 'add_edge' then
        insert into public.workflow_edges (
          id, workflow_id, source_node_id, source_port,
          target_node_id, target_port, value_type
        ) values (
          (v_op #>> '{edge,id}')::uuid, v_workflow.id,
          (v_op #>> '{edge,sourceNodeId}')::uuid, v_op #>> '{edge,sourcePort}',
          (v_op #>> '{edge,targetNodeId}')::uuid, v_op #>> '{edge,targetPort}',
          (v_op #>> '{edge,valueType}')::public.flow_value_type
        );
      when 'remove_edge' then
        delete from public.workflow_edges
         where id = (v_op ->> 'edgeId')::uuid and workflow_id = v_workflow.id;
      else
        raise exception using errcode = 'P0001', message = 'PATCH_OPERATION_INVALID';
    end case;
  end loop;

  update public.workflow_patch_proposals set status = 'applied', resolved_at = now()
   where id = v_proposal.id;
  select * into v_workflow from public.workflows where id = v_workflow.id;
  return jsonb_build_object('graphRevision', v_workflow.graph_revision);
end;
$$;

revoke all on function public.apply_workflow_patch(uuid, uuid) from public, anon, authenticated;
grant execute on function public.apply_workflow_patch(uuid, uuid) to service_role;

comment on function public.create_workflow_run is
  '锁定当前图 revision，捕获不可变快照并幂等创建运行计划。';
comment on function public.land_workflow_generation_result_once is
  'Flow 生成产出只写资产和运行输出，不创建 Canvas 节点。';

-- 即时触发失败时，持久 Run 状态仍由 cron 每 15 秒重新推进。
select cron.schedule(
  'neocanvas-process-workflow-queue',
  '15 seconds',
  $cron$ select private.invoke_edge_function('process-workflow-queue'); $cron$
);
