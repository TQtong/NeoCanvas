begin;

create extension if not exists pgtap with schema extensions;
select plan(31);

-- 独立测试命名空间；事务末尾整体回滚，不污染本地开发数据。
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-0000-0000-000000000001',
   'authenticated', 'authenticated', 'generation-owner@example.test', '', now(), '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-0000-0000-000000000002',
   'authenticated', 'authenticated', 'generation-other@example.test', '', now(), '{}', '{}', now(), now());

insert into public.model_catalog (
  key, display_name, provider, modality, capabilities, default_params, sort_order, is_active
) values (
  'transaction-test-image', 'Transaction Test Image', 'openai', 'image',
  '{"aspectRatios":["1:1"],"sizes":[],"maxOutputs":4,"supportsNegativePrompt":true,"supportsReferenceImages":true,"supportsImageToVideo":false,"supportsSeed":true,"qualities":["auto"],"isAsync":false,"supportsWebhook":false}',
  '{"aspectRatio":"1:1","count":1}', 9999, true
);

insert into public.model_catalog (
  key, display_name, provider, modality, capabilities, default_params, sort_order, is_active, user_id
) values
  ('transaction-other-private', 'Other Private', 'openai', 'image',
   '{"aspectRatios":["1:1"],"sizes":[],"maxOutputs":1,"supportsNegativePrompt":false,"supportsReferenceImages":false,"supportsImageToVideo":false,"supportsSeed":false,"qualities":[],"isAsync":false,"supportsWebhook":false}',
   '{}', 10000, true, '10000000-0000-0000-0000-000000000002'),
  ('transaction-custom-no-credential', 'Custom No Credential', 'custom:transaction', 'image',
   '{"aspectRatios":["1:1"],"sizes":[],"maxOutputs":1,"supportsNegativePrompt":false,"supportsReferenceImages":false,"supportsImageToVideo":false,"supportsSeed":false,"qualities":[],"isAsync":false,"supportsWebhook":false}',
   '{}', 10001, true, '10000000-0000-0000-0000-000000000001');

insert into public.projects (id, owner_id, title)
values
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'Atomic Project'),
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'Scoped Project');

insert into public.conversations (id, project_id, title)
values
  ('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'Main'),
  ('30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002', 'Other');

insert into public.messages (id, conversation_id, role, content)
values
  ('40000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'user', '生成两张图'),
  ('40000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000002', 'user', '另一个项目');

insert into public.canvas_nodes (
  id, project_id, type, position_x, position_y, width, height, data, created_by
) values (
  '50000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001',
  'image', 0, 0, 320, 320, '{"assetId":null,"mediaRole":"primary"}',
  '10000000-0000-0000-0000-000000000001'
);

create temporary table submission_result as
select public.create_generation_submission(
  '10000000-0000-0000-0000-000000000001',
  '60000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000001',
  '40000000-0000-0000-0000-000000000001',
  'image', 'transaction-test-image', '生成两张图',
  '{"modality":"image","count":2,"references":[]}',
  'atomic-key', 'request-hash-1',
  '70000000-0000-0000-0000-000000000001',
  '{"x":400,"y":100,"width":320,"height":320}',
  '50000000-0000-0000-0000-000000000001',
  'candidate_for_target', 'generation', 8
) as result;

select is(
  (select result ->> 'generationId' from submission_result),
  '60000000-0000-0000-0000-000000000001',
  '原子提交返回 generation id'
);
select is((select result ->> 'placeholderNodeId' from submission_result),
  '70000000-0000-0000-0000-000000000001', '原子提交返回占位 id');
select ok((select (result ->> 'queueMessageId') is not null from submission_result),
  '队列消息与任务在同一事务创建');
select is((select count(*)::integer from public.generations where id = '60000000-0000-0000-0000-000000000001'),
  1, '只创建一条 generation');
select is((select count(*)::integer from public.canvas_nodes where id = '70000000-0000-0000-0000-000000000001' and type = 'generation_placeholder'),
  1, '创建占位节点');
select is((select count(*)::integer from public.canvas_edges where target_node_id = '70000000-0000-0000-0000-000000000001' and type = 'media_candidate'),
  1, '候选边在提交事务中创建');
select is((select count(*)::integer from public.canvas_nodes where type = 'media_panel' and data ->> 'targetNodeId' = '70000000-0000-0000-0000-000000000001'),
  1, '候选面板在提交事务中创建');

select ok((public.create_generation_submission(
  '10000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000099',
  '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001',
  '40000000-0000-0000-0000-000000000001', 'image', 'transaction-test-image', '生成两张图',
  '{"modality":"image","count":2,"references":[]}', 'atomic-key', 'request-hash-1',
  '70000000-0000-0000-0000-000000000099', '{"x":0,"y":0,"width":320,"height":320}',
  '50000000-0000-0000-0000-000000000001', 'candidate_for_target', 'generation', 8
) ->> 'reused')::boolean, '相同作用域与摘要复用完整提交');
select is((select count(*)::integer from public.generations where project_id = '20000000-0000-0000-0000-000000000001'),
  1, '幂等命中不重复创建任务');

select throws_ok(
  $$select public.create_generation_submission(
    '10000000-0000-0000-0000-000000000001', gen_random_uuid(),
    '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001',
    '40000000-0000-0000-0000-000000000001', 'image', 'transaction-test-image', '冲突文本',
    '{"modality":"image","count":1,"references":[]}', 'atomic-key', 'different-hash', gen_random_uuid(),
    '{"x":0,"y":0,"width":320,"height":320}', null, 'new_primary', 'generation', 8
  )$$,
  'P0001', 'IDEMPOTENCY_CONFLICT', '相同幂等键携带不同语义明确冲突'
);

select throws_ok(
  $$select public.create_generation_submission(
    '10000000-0000-0000-0000-000000000001', gen_random_uuid(),
    '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001',
    '40000000-0000-0000-0000-000000000001', 'image', 'transaction-other-private', '越权模型',
    '{"modality":"image","count":1,"references":[]}', 'private-model-key', 'private-hash', gen_random_uuid(),
    '{"x":0,"y":0,"width":320,"height":320}', null, 'new_primary', 'generation', 8
  )$$,
  'P0001', 'MODEL_NOT_ACCESSIBLE', '其他用户私有模型不可访问'
);

select throws_ok(
  $$select public.create_generation_submission(
    '10000000-0000-0000-0000-000000000001', gen_random_uuid(),
    '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001',
    '40000000-0000-0000-0000-000000000001', 'image', 'transaction-custom-no-credential', '缺凭据',
    '{"modality":"image","count":1,"references":[]}', 'credential-key', 'credential-hash', gen_random_uuid(),
    '{"x":0,"y":0,"width":320,"height":320}', null, 'new_primary', 'generation', 8
  )$$,
  'P0001', 'MODEL_CREDENTIAL_UNAVAILABLE', '自定义 Provider 缺少启用凭据时拒绝'
);

select is((select count(*)::integer from public.generations where requester_id = '10000000-0000-0000-0000-000000000001'), 1,
  '所有提交验证失败均在写任务前回滚');

-- 同一用户相同 key 在另一个项目属于独立幂等作用域。
select ok((public.create_generation_submission(
  '10000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000002',
  '20000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000002',
  '40000000-0000-0000-0000-000000000002', 'image', 'transaction-test-image', '另一个项目',
  '{"modality":"image","count":1,"references":[]}', 'atomic-key', 'request-hash-2',
  '70000000-0000-0000-0000-000000000002', '{"x":0,"y":0,"width":320,"height":320}',
  null, 'new_primary', 'generation', 8
) ->> 'reused')::boolean = false, '幂等键按项目隔离');
select is((select count(*)::integer from public.generations where requester_id = '10000000-0000-0000-0000-000000000001'), 2,
  '跨项目相同 key 可创建独立任务');

insert into public.generation_output_attempts (
  id, generation_id, owner_id, staging_prefix, storage_bucket, object_paths, status
) values (
  '80000000-0000-0000-0000-000000000001',
  '60000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001',
  'staging/10000000-0000-0000-0000-000000000001/60000000-0000-0000-0000-000000000001/80000000-0000-0000-0000-000000000001/',
  'generations',
  '["staging/10000000-0000-0000-0000-000000000001/60000000-0000-0000-0000-000000000001/80000000-0000-0000-0000-000000000001/a.png","staging/10000000-0000-0000-0000-000000000001/60000000-0000-0000-0000-000000000001/80000000-0000-0000-0000-000000000001/b.png"]',
  'staged'
);

create temporary table landing_result as
select public.land_generation_result_once(
  '60000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000001',
  '70000000-0000-0000-0000-000000000001',
  '80000000-0000-0000-0000-000000000001',
  '[{"id":"90000000-0000-0000-0000-000000000001","kind":"image","mimeType":"image/png","storageBucket":"generations","storagePath":"staging/10000000-0000-0000-0000-000000000001/60000000-0000-0000-0000-000000000001/80000000-0000-0000-0000-000000000001/a.png","width":320,"height":320,"sizeBytes":100},{"id":"90000000-0000-0000-0000-000000000002","kind":"image","mimeType":"image/png","storageBucket":"generations","storagePath":"staging/10000000-0000-0000-0000-000000000001/60000000-0000-0000-0000-000000000001/80000000-0000-0000-0000-000000000001/b.png","width":320,"height":320,"sizeBytes":100}]',
  '{"type":"image","assetId":"90000000-0000-0000-0000-000000000001","data":{"mediaRole":"candidate","candidateOf":"50000000-0000-0000-0000-000000000001"}}',
  '[{"id":"71000000-0000-0000-0000-000000000001","type":"image","positionX":760,"positionY":100,"width":320,"height":320,"assetId":"90000000-0000-0000-0000-000000000002","data":{"mediaRole":"candidate","candidateOf":"50000000-0000-0000-0000-000000000001"}}]',
  '90000000-0000-0000-0000-000000000001',
  '{"provider":"fake","outputCount":2}'
) as result;

select ok((select (result ->> 'landed')::boolean from landing_result), '首个完成者成功落库');
select is((select status::text from public.generations where id = '60000000-0000-0000-0000-000000000001'),
  'succeeded', '任务原子进入 succeeded');
select is((select count(*)::integer from public.assets where generation_id = '60000000-0000-0000-0000-000000000001'),
  2, '两份资产只落库一次');
select is((select count(*)::integer from public.canvas_nodes where generation_id = '60000000-0000-0000-0000-000000000001'),
  2, '占位改写与额外节点在同一事务');
select is((select count(*)::integer from public.canvas_edges where source_node_id = '50000000-0000-0000-0000-000000000001' and type = 'media_candidate'),
  2, '所有候选边在结果事务内补齐且无重复');
select is((select count(*)::integer from public.canvas_nodes where type = 'media_panel' and data ->> 'targetNodeId' in ('70000000-0000-0000-0000-000000000001','71000000-0000-0000-0000-000000000001')),
  2, '所有候选面板在结果事务内补齐且无重复');
select is((select status from public.generation_output_attempts where id = '80000000-0000-0000-0000-000000000001'),
  'committed', '获胜暂存尝试标记 committed');

insert into public.generation_output_attempts (
  id, generation_id, owner_id, staging_prefix, object_paths, status
) values (
  '80000000-0000-0000-0000-000000000002', '60000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001',
  'staging/10000000-0000-0000-0000-000000000001/60000000-0000-0000-0000-000000000001/80000000-0000-0000-0000-000000000002/',
  '["staging/10000000-0000-0000-0000-000000000001/60000000-0000-0000-0000-000000000001/80000000-0000-0000-0000-000000000002/late.png"]', 'staged'
);

select ok(not (public.land_generation_result_once(
  '60000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000001', '70000000-0000-0000-0000-000000000001',
  '80000000-0000-0000-0000-000000000002',
  '[{"id":"90000000-0000-0000-0000-000000000099","kind":"image","mimeType":"image/png","storageBucket":"generations","storagePath":"staging/10000000-0000-0000-0000-000000000001/60000000-0000-0000-0000-000000000001/80000000-0000-0000-0000-000000000002/late.png"}]',
  null, '[]', '90000000-0000-0000-0000-000000000099', '{}'
) ->> 'landed')::boolean, '迟到完成者得到 landed=false');
select is((select count(*)::integer from public.assets where id = '90000000-0000-0000-0000-000000000099'),
  0, '迟到完成者不写任何资产');
select is((select status from public.generation_output_attempts where id = '80000000-0000-0000-0000-000000000002'),
  'discarded', '迟到暂存尝试标记 discarded 供补偿清理');
select ok(not (public.fail_generation_once('60000000-0000-0000-0000-000000000001', '迟到失败', null) ->> 'changed')::boolean,
  '迟到失败不能覆盖 succeeded');
select is((select status::text from public.generations where id = '60000000-0000-0000-0000-000000000001'),
  'succeeded', '成功终态保持不变');

select ok(not has_function_privilege('anon', 'public.create_generation_submission(uuid,uuid,uuid,uuid,uuid,modality,text,text,jsonb,text,text,uuid,jsonb,uuid,text,text,integer)', 'EXECUTE'),
  'anon 无权执行原子提交 RPC');
select ok(not has_function_privilege('authenticated', 'public.land_generation_result_once(uuid,uuid,uuid,uuid,uuid,jsonb,jsonb,jsonb,uuid,jsonb)', 'EXECUTE'),
  'authenticated 无权执行 landing RPC');
select ok(has_function_privilege('service_role', 'public.land_generation_result_once(uuid,uuid,uuid,uuid,uuid,jsonb,jsonb,jsonb,uuid,jsonb)', 'EXECUTE'),
  'service_role 可执行 landing RPC');
select ok(not has_table_privilege('authenticated', 'public.generation_output_attempts', 'SELECT'),
  'authenticated 无法读取暂存尝试账本');

select * from finish();
rollback;
