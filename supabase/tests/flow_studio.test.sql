begin;
select plan(27);

select has_table('public', 'workflows', 'workflows table exists');
select has_table('public', 'workflow_nodes', 'workflow_nodes table exists');
select has_table('public', 'workflow_edges', 'workflow_edges table exists');
select has_table('public', 'workflow_revisions', 'workflow_revisions table exists');
select has_table('public', 'workflow_runs', 'workflow_runs table exists');
select has_table('public', 'workflow_run_nodes', 'workflow_run_nodes table exists');
select has_table('public', 'workflow_run_outputs', 'workflow outputs table exists');
select has_table('public', 'workflow_templates', 'templates table exists');
select has_table('public', 'flow_apps', 'flow apps table exists');
select has_table('public', 'workflow_patch_proposals', 'patch proposals table exists');
select has_column('public', 'generations', 'workflow_run_node_id', 'generation links run node');
select col_is_fk('public', 'generations', 'workflow_run_node_id', 'generation run node is protected by FK');

-- 原子运行、不可变修订、幂等冲突与文本输出发布。
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000000', 'f0000000-0000-0000-0000-000000000001',
  'authenticated', 'authenticated', 'flow-owner@example.test', '', now(), '{}', '{}', now(), now()
);

insert into public.projects (id, owner_id, title) values (
  'e0000000-0000-0000-0000-000000000001',
  'f0000000-0000-0000-0000-000000000001', 'Flow Atomic Project'
);

insert into public.workflows (id, project_id, owner_id, name) values (
  'd0000000-0000-0000-0000-000000000001',
  'e0000000-0000-0000-0000-000000000001',
  'f0000000-0000-0000-0000-000000000001', 'Publish Text'
);

insert into public.workflow_nodes (id, workflow_id, kind, position_x, position_y, config) values
  ('c0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001',
   'text_input', 0, 0, '{"value":"已发布文案"}'),
  ('c0000000-0000-0000-0000-000000000002', 'd0000000-0000-0000-0000-000000000001',
   'text_output', 360, 0, '{}');

insert into public.workflow_edges (
  id, workflow_id, source_node_id, source_port, target_node_id, target_port, value_type
) values (
  'b0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001',
  'c0000000-0000-0000-0000-000000000001', 'text',
  'c0000000-0000-0000-0000-000000000002', 'text', 'text'
);

select is(
  (select graph_revision::integer from public.workflows where id = 'd0000000-0000-0000-0000-000000000001'),
  3, '节点和边变更逐次推进图修订'
);

create temporary table workflow_run_result as
select public.create_workflow_run(
  'f0000000-0000-0000-0000-000000000001',
  '90000000-0000-0000-0000-000000000001',
  'd0000000-0000-0000-0000-000000000001',
  3, '0123456789abcdef0123456789abcdef', 'all', null, false,
  'flow-idempotency-key', 'abcdef0123456789abcdef0123456789',
  array[
    'c0000000-0000-0000-0000-000000000001'::uuid,
    'c0000000-0000-0000-0000-000000000002'::uuid
  ]
) as result;

select is((select (result ->> 'deduplicated')::boolean from workflow_run_result), false,
  '首次启动创建运行');
select is((select count(*)::integer from public.workflow_revisions), 1,
  '首次运行固化一份不可变修订');
select is((select count(*)::integer from public.workflow_revision_nodes), 2,
  '不可变修订包含完整节点快照');
select is((select count(*)::integer from public.workflow_run_nodes), 2,
  '执行计划只创建计划内运行节点');
select is((select count(*)::integer from public.workflow_run_input_links), 1,
  '修订边被解析为运行输入链接');

insert into public.model_catalog (
  key, display_name, provider, modality, capabilities, default_params, sort_order, is_active
) values (
  'flow-provider-snapshot', 'Flow Provider Snapshot', 'openai', 'image', '{}',
  '{"providerModel":"gpt-image-v-test"}', 9998, true
);
update public.workflow_run_nodes
   set model_key = 'flow-provider-snapshot', resolved_provider_model = 'flow-provider-snapshot'
 where run_id = '90000000-0000-0000-0000-000000000001' and kind = 'text_output';
select is((
  select provider || ':' || resolved_provider_model from public.workflow_run_nodes
   where run_id = '90000000-0000-0000-0000-000000000001' and kind = 'text_output'
), 'openai:gpt-image-v-test', '运行节点固定真实 Provider 模型标识');

select ok((public.create_workflow_run(
  'f0000000-0000-0000-0000-000000000001', gen_random_uuid(),
  'd0000000-0000-0000-0000-000000000001',
  3, '0123456789abcdef0123456789abcdef', 'all', null, false,
  'flow-idempotency-key', 'abcdef0123456789abcdef0123456789',
  array[
    'c0000000-0000-0000-0000-000000000001'::uuid,
    'c0000000-0000-0000-0000-000000000002'::uuid
  ]
) ->> 'deduplicated')::boolean, '相同幂等键和请求摘要复用运行');
select is((select count(*)::integer from public.workflow_runs), 1,
  '幂等复用不重复创建运行');

select throws_ok(
  $$select public.create_workflow_run(
    'f0000000-0000-0000-0000-000000000001', gen_random_uuid(),
    'd0000000-0000-0000-0000-000000000001',
    3, '0123456789abcdef0123456789abcdef', 'all', null, false,
    'flow-idempotency-key', 'ffffffffffffffffffffffffffffffff',
    array['c0000000-0000-0000-0000-000000000001'::uuid]
  )$$,
  'P0001', 'IDEMPOTENCY_CONFLICT', '相同幂等键携带不同请求摘要明确冲突'
);

select throws_ok(
  $$select public.create_workflow_run(
    'f0000000-0000-0000-0000-000000000001', gen_random_uuid(),
    'd0000000-0000-0000-0000-000000000001',
    2, '0123456789abcdef0123456789abcdef', 'all', null, false,
    'stale-revision', '99999999999999999999999999999999',
    array['c0000000-0000-0000-0000-000000000001'::uuid]
  )$$,
  'P0001', 'WORKFLOW_REVISION_CONFLICT', '过期图修订不能启动运行'
);

insert into public.workflow_run_outputs (
  id, run_node_id, port_id, value_type, value, ordinal
) select
  'a0000000-0000-0000-0000-000000000001', id, 'text', 'text',
  to_jsonb('已发布文案'::text), 0
from public.workflow_run_nodes
where run_id = '90000000-0000-0000-0000-000000000001' and kind = 'text_output';

select is(
  jsonb_array_length(public.publish_workflow_outputs(
    'f0000000-0000-0000-0000-000000000001',
    '90000000-0000-0000-0000-000000000001',
    array['a0000000-0000-0000-0000-000000000001'::uuid]
  ) -> 'nodeIds'), 1, '文本输出发布返回一个 Canvas 节点'
);
select is((
  select data ->> 'text' from public.canvas_nodes
   where project_id = 'e0000000-0000-0000-0000-000000000001' and type = 'text'
), '已发布文案', '文本工作流输出写入普通 Canvas 文本节点');

select public.publish_workflow_outputs(
  'f0000000-0000-0000-0000-000000000001',
  '90000000-0000-0000-0000-000000000001',
  array['a0000000-0000-0000-0000-000000000001'::uuid]
);
insert into public.workflow_run_outputs (
  id, run_node_id, port_id, value_type, value, ordinal
) select
  'a0000000-0000-0000-0000-000000000002', id, 'text', 'text',
  to_jsonb('中间结果不得发布'::text), 0
from public.workflow_run_nodes
where run_id = '90000000-0000-0000-0000-000000000001' and kind = 'text_input';
select is(
  jsonb_array_length(public.publish_workflow_outputs(
    'f0000000-0000-0000-0000-000000000001',
    '90000000-0000-0000-0000-000000000001',
    array['a0000000-0000-0000-0000-000000000002'::uuid]
  ) -> 'nodeIds'), 0, '中间节点结果不能绕过显式输出节点发布'
);
select is((select count(*)::integer from public.canvas_nodes
  where project_id = 'e0000000-0000-0000-0000-000000000001'), 1,
  '重复发布复用来源输出已绑定的 Canvas 节点');

select * from finish();
rollback;
