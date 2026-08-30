begin;

create extension if not exists pgtap with schema extensions;
select plan(41);

select is(
  (select count(*) from public.model_catalog
    where key in ('fal-inpaint-sdxl','fal-remove-background-birefnet','fal-upscale-topaz')
      and provider = 'fal'
      and not (capabilities -> 'imageOperations' ? 'generate')),
  3::bigint,
  'fal 三个工具以不含普通生成能力的独立目录项登记'
);
select is(
  (select count(*) from public.model_catalog
    where key in ('replicate-inpaint-sd2','replicate-remove-background','replicate-upscale-real-esrgan')
      and provider = 'replicate'
      and (default_params ->> 'providerModel') like 'neocanvas:replicate:%'
      and not (capabilities -> 'imageOperations' ? 'generate')),
  3::bigint,
  'Replicate 三个工具只能通过受控 Profile 目录登记'
);
select is(
  (select count(*) from public.model_catalog
    where key in ('jimeng-inpaint','jimeng-outpaint','jimeng-remove-background','jimeng-upscale')
      and provider = 'jimeng'
      and not (capabilities -> 'imageOperations' ? 'generate')),
  4::bigint,
  '即梦四个专业工具以不含普通生成能力的独立 Profile 登记'
);
select is(
  (select capabilities -> 'imageOperations' from public.model_catalog
    where key = 'jimeng-image-4.0'),
  '["generate", "semantic_edit"]'::jsonb,
  '即梦图片 4.0 只开放已验证的生成与语义编辑能力'
);
select is(
  (select capabilities -> 'imageOperations' from public.model_catalog
    where key = 'nano-banana-pro'),
  '["generate", "semantic_edit"]'::jsonb,
  'Google 只开放普通生成与语义编辑'
);
select is(
  (select default_params ->> 'providerModel' from public.model_catalog
    where key = 'nano-banana-pro'),
  'gemini-3-pro-image',
  'Nano Banana Pro 绑定当前稳定版 Gemini 3 Pro Image'
);
select ok(
  (select (capabilities ->> 'maxOutputs')::integer = 1
       and (capabilities ->> 'maxInputImages')::integer = 14
     from public.model_catalog where key = 'nano-banana-pro'),
  'Google 同步接口固定单候选并登记完整参考图上限'
);
select is(
  (select count(*) from public.model_catalog
    where key in ('minimax-image-01', 'minimax-image-01-live')
      and capabilities -> 'imageOperations' = '["generate", "semantic_edit"]'::jsonb
      and (capabilities ->> 'maxInputImages')::integer = 1),
  2::bigint,
  'MiniMax 两个图片模型仅支持单人物源图语义编辑'
);
select is(
  (select count(*) from public.model_catalog
    where key in ('siliconflow-qwen-image-edit', 'siliconflow-qwen-image-edit-2509')
      and capabilities -> 'imageOperations' = '["semantic_edit"]'::jsonb
      and not (capabilities -> 'imageOperations' ? 'generate')),
  2::bigint,
  'SiliconFlow 只有两个已验证 Qwen 编辑模型进入语义编辑入口'
);
select is(
  (select count(*) from public.model_catalog
    where provider = 'siliconflow'
      and modality = 'image'
      and key not in ('siliconflow-qwen-image-edit', 'siliconflow-qwen-image-edit-2509')
      and capabilities -> 'imageOperations' = '["generate"]'::jsonb),
  5::bigint,
  'SiliconFlow 普通图片模型只开放 generate'
);
select is(
  (select (capabilities ->> 'maxInputImages')::integer from public.model_catalog
    where key = 'siliconflow-qwen-image-edit'),
  1,
  '旧版 Qwen Image Edit 只接受一个内容源图'
);
select is(
  (select (capabilities ->> 'maxInputImages')::integer from public.model_catalog
    where key = 'siliconflow-qwen-image-edit-2509'),
  3,
  'Qwen Image Edit 2509 接受一个内容源图和两个辅助参考图'
);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  ('00000000-0000-0000-0000-000000000000', '11000000-0000-0000-0000-000000000001',
   'authenticated', 'authenticated', 'precision-owner@example.test', '', now(), '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '11000000-0000-0000-0000-000000000002',
   'authenticated', 'authenticated', 'precision-other@example.test', '', now(), '{}', '{}', now(), now());

insert into public.model_catalog (
  key, display_name, provider, modality, capabilities, default_params, sort_order, is_active
) values (
  'precision-test-image', 'Precision Test Image', 'openai', 'image',
  '{"imageOperations":["generate","semantic_edit","inpaint","outpaint"],"aspectRatios":["1:1"],"sizes":[],"maxOutputs":4,"supportsNegativePrompt":false,"supportsReferenceImages":true,"supportsImageToVideo":false,"supportsSeed":false,"qualities":["auto"],"isAsync":false,"supportsWebhook":false,"maxInputImages":2,"inputFidelityOptions":["standard","high"],"upscaleFactors":[],"supportsTransparentOutput":true,"maxInputPixels":16777216}',
  '{"aspectRatio":"1:1","count":1}', 12000, true
);

insert into public.projects (id, owner_id, title)
values
  ('21000000-0000-0000-0000-000000000001', '11000000-0000-0000-0000-000000000001', 'Precision Project'),
  ('21000000-0000-0000-0000-000000000002', '11000000-0000-0000-0000-000000000002', 'Foreign Project');

insert into public.assets (
  id, owner_id, project_id, kind, source, storage_bucket, storage_path, mime_type,
  width, height, is_auxiliary
) values
  ('91000000-0000-0000-0000-000000000001', '11000000-0000-0000-0000-000000000001',
   '21000000-0000-0000-0000-000000000001', 'image', 'upload', 'uploads',
   '11000000-0000-0000-0000-000000000001/21000000-0000-0000-0000-000000000001/source.png',
   'image/png', 320, 200, false),
  ('91000000-0000-0000-0000-000000000002', '11000000-0000-0000-0000-000000000001',
   '21000000-0000-0000-0000-000000000001', 'image', 'upload', 'uploads',
   '11000000-0000-0000-0000-000000000001/21000000-0000-0000-0000-000000000001/edit-inputs/mask.png',
   'image/png', 320, 200, true),
  ('91000000-0000-0000-0000-000000000003', '11000000-0000-0000-0000-000000000002',
   '21000000-0000-0000-0000-000000000002', 'image', 'upload', 'uploads',
   '11000000-0000-0000-0000-000000000002/21000000-0000-0000-0000-000000000002/foreign.png',
   'image/png', 320, 200, false),
  ('91000000-0000-0000-0000-000000000004', '11000000-0000-0000-0000-000000000001',
   '21000000-0000-0000-0000-000000000001', 'image', 'generation', 'generations',
   '11000000-0000-0000-0000-000000000001/21000000-0000-0000-0000-000000000001/outpaint.png',
   'image/png', 600, 400, false),
  ('91000000-0000-0000-0000-000000000005', '11000000-0000-0000-0000-000000000001',
   '21000000-0000-0000-0000-000000000001', 'image', 'generation', 'generations',
   '11000000-0000-0000-0000-000000000001/21000000-0000-0000-0000-000000000001/semantic.png',
   'image/png', 600, 400, false);

insert into public.canvas_nodes (
  id, project_id, type, position_x, position_y, width, height, data, asset_id, created_by
) values (
  '51000000-0000-0000-0000-000000000001', '21000000-0000-0000-0000-000000000001',
  'image', 100, 100, 320, 200, '{"assetId":"91000000-0000-0000-0000-000000000001","mediaRole":"primary"}',
  '91000000-0000-0000-0000-000000000001', '11000000-0000-0000-0000-000000000001'
);

create temporary table precision_submission as
select public.create_generation_submission(
  '11000000-0000-0000-0000-000000000001',
  '61000000-0000-0000-0000-000000000001',
  '21000000-0000-0000-0000-000000000001',
  null, null, 'image', 'precision-test-image', '只修改白色蒙版区域',
  '{"modality":"image","operation":"inpaint","inputMode":"original","count":1,"maskFeatherPx":16,"references":[{"origin":"attachment","assetId":"91000000-0000-0000-0000-000000000001","role":"content"},{"origin":"attachment","assetId":"91000000-0000-0000-0000-000000000002","role":"mask"}]}',
  'precision-inpaint-key', 'precision-inpaint-hash',
  '71000000-0000-0000-0000-000000000001',
  '{"x":460,"y":100,"width":320,"height":200}',
  '[{"assetId":"91000000-0000-0000-0000-000000000001","role":"content"},{"assetId":"91000000-0000-0000-0000-000000000002","role":"mask"}]',
  '51000000-0000-0000-0000-000000000001',
  'candidate_for_target', 'image:inpaint', 8
) as result;

select has_column('public', 'assets', 'is_auxiliary', 'assets 具有辅助资产标记');
select has_table('public', 'generation_inputs', '存在结构化生成输入表');
select is((select is_auxiliary from public.assets where id = '91000000-0000-0000-0000-000000000001'),
  false, '普通源资产不会被标记为辅助资产');
select is((select is_auxiliary from public.assets where id = '91000000-0000-0000-0000-000000000002'),
  true, '蒙版资产被标记为辅助资产');
select is((select operation_type from public.generations where id = '61000000-0000-0000-0000-000000000001'),
  'image:inpaint', '编辑任务写入独立幂等操作域');
select is((select count(*)::integer from public.generation_inputs where generation_id = '61000000-0000-0000-0000-000000000001'),
  2, '原子提交写入全部输入血缘');
select is((select role from public.generation_inputs where generation_id = '61000000-0000-0000-0000-000000000001' and ordinal = 0),
  'content', '源图保存在第一个输入位置');
select is((select role from public.generation_inputs where generation_id = '61000000-0000-0000-0000-000000000001' and ordinal = 1),
  'mask', '蒙版保存在第二个输入位置');

select ok((public.create_generation_submission(
  '11000000-0000-0000-0000-000000000001', gen_random_uuid(),
  '21000000-0000-0000-0000-000000000001', null, null, 'image',
  'precision-test-image', '只修改白色蒙版区域',
  '{"modality":"image","operation":"inpaint","inputMode":"original","count":1,"maskFeatherPx":16,"references":[{"origin":"attachment","assetId":"91000000-0000-0000-0000-000000000001","role":"content"},{"origin":"attachment","assetId":"91000000-0000-0000-0000-000000000002","role":"mask"}]}',
  'precision-inpaint-key', 'precision-inpaint-hash', gen_random_uuid(),
  '{"x":0,"y":0,"width":320,"height":200}',
  '[{"assetId":"91000000-0000-0000-0000-000000000001","role":"content"},{"assetId":"91000000-0000-0000-0000-000000000002","role":"mask"}]',
  '51000000-0000-0000-0000-000000000001', 'candidate_for_target', 'image:inpaint', 8
) ->> 'reused')::boolean, '幂等重试复用原编辑任务');
select is((select count(*)::integer from public.generation_inputs where generation_id = '61000000-0000-0000-0000-000000000001'),
  2, '幂等重试不重复写输入');

select throws_ok(
  $$select public.create_generation_submission(
    '11000000-0000-0000-0000-000000000001', gen_random_uuid(),
    '21000000-0000-0000-0000-000000000001', null, null, 'image',
    'precision-test-image', '越权输入',
    '{"modality":"image","operation":"semantic_edit","inputMode":"original","count":1,"references":[]}',
    'precision-foreign-key', 'precision-foreign-hash', gen_random_uuid(),
    '{"x":0,"y":0,"width":320,"height":200}',
    '[{"assetId":"91000000-0000-0000-0000-000000000003","role":"content"}]',
    '51000000-0000-0000-0000-000000000001', 'candidate_for_target', 'image:semantic_edit', 8
  )$$,
  'P0001', 'GENERATION_INPUT_FORBIDDEN', '跨项目资产不能成为编辑输入'
);
select is((select count(*)::integer from public.generations where requester_id = '11000000-0000-0000-0000-000000000001'),
  1, '输入验证失败不会留下部分 generation');

set local role authenticated;
select set_config('request.jwt.claim.sub', '11000000-0000-0000-0000-000000000001', true);
select is((select count(*)::integer from public.generation_inputs), 2, '项目所有者可以读取自己的输入血缘');
select set_config('request.jwt.claim.sub', '11000000-0000-0000-0000-000000000002', true);
select is((select count(*)::integer from public.generation_inputs), 0, '其他用户不能读取输入血缘');
reset role;

select ok(not has_table_privilege('authenticated', 'public.generation_inputs', 'INSERT'),
  'authenticated 不能直接写 generation_inputs');
select ok(has_function_privilege('service_role',
  'public.create_generation_submission(uuid,uuid,uuid,uuid,uuid,modality,text,text,jsonb,text,text,uuid,jsonb,jsonb,uuid,text,text,integer)',
  'EXECUTE'), 'service_role 可以执行带输入血缘的原子提交');
select ok(not has_function_privilege('anon',
  'public.create_generation_submission(uuid,uuid,uuid,uuid,uuid,modality,text,text,jsonb,text,text,uuid,jsonb,jsonb,uuid,text,text,integer)',
  'EXECUTE'), 'anon 不能执行带输入血缘的原子提交');

insert into public.generations (
  id, requester_id, project_id, modality, model_key, provider, params, status,
  operation_type, result_mode, target_node_id
) values (
  '62000000-0000-0000-0000-000000000001', '11000000-0000-0000-0000-000000000001',
  '21000000-0000-0000-0000-000000000001', 'image', 'precision-test-image', 'openai',
  '{"modality":"image","operation":"outpaint","inputMode":"original","count":1,"references":[]}',
  'succeeded', 'image:outpaint', 'candidate_for_target', '51000000-0000-0000-0000-000000000001'
);

insert into public.canvas_nodes (
  id, project_id, type, position_x, position_y, width, height, data,
  asset_id, generation_id, created_by
) values (
  '52000000-0000-0000-0000-000000000001', '21000000-0000-0000-0000-000000000001',
  'image', 500, 50, 600, 400,
  '{"assetId":"91000000-0000-0000-0000-000000000004","mediaRole":"candidate","candidateOf":"51000000-0000-0000-0000-000000000001","candidateIndex":0}',
  '91000000-0000-0000-0000-000000000004', '62000000-0000-0000-0000-000000000001',
  '11000000-0000-0000-0000-000000000001'
);
insert into public.canvas_edges (
  project_id, source_node_id, target_node_id, type, data
) values (
  '21000000-0000-0000-0000-000000000001', '51000000-0000-0000-0000-000000000001',
  '52000000-0000-0000-0000-000000000001', 'media_candidate', '{"label":"候选"}'
);

select throws_ok(
  $$select public.swap_media_candidate(
    '21000000-0000-0000-0000-000000000001',
    '51000000-0000-0000-0000-000000000001',
    '52000000-0000-0000-0000-000000000001',
    'preserve_frame'
  )$$,
  'P0001', 'CANDIDATE_GEOMETRY_OPERATION_MISMATCH', '扩图候选不能错误地保留旧外框'
);
select ok(public.swap_media_candidate(
  '21000000-0000-0000-0000-000000000001',
  '51000000-0000-0000-0000-000000000001',
  '52000000-0000-0000-0000-000000000001',
  'adopt_output_geometry'
), '扩图候选可以采用输出几何');
select is((select asset_id::text from public.canvas_nodes where id = '51000000-0000-0000-0000-000000000001'),
  '91000000-0000-0000-0000-000000000004', '主节点 id 不变并取得扩图资产');
select is((select width::integer from public.canvas_nodes where id = '51000000-0000-0000-0000-000000000001'),
  600, '主节点采用扩图宽度');
select is((select position_x::integer from public.canvas_nodes where id = '51000000-0000-0000-0000-000000000001'),
  -40, '主节点采用扩图宽度后保持原中心点');
select is((select width::integer from public.canvas_nodes where id = '52000000-0000-0000-0000-000000000001'),
  320, '候选节点保存旧主节点宽度');
select is((select asset_id::text from public.canvas_nodes where id = '52000000-0000-0000-0000-000000000001'),
  '91000000-0000-0000-0000-000000000001', '候选节点保存旧主节点资产');

insert into public.generations (
  id, requester_id, project_id, modality, model_key, provider, params, status,
  operation_type, result_mode, target_node_id
) values (
  '62000000-0000-0000-0000-000000000002', '11000000-0000-0000-0000-000000000001',
  '21000000-0000-0000-0000-000000000001', 'image', 'precision-test-image', 'openai',
  '{"modality":"image","operation":"semantic_edit","inputMode":"original","count":1,"references":[]}',
  'succeeded', 'image:semantic_edit', 'candidate_for_target', '51000000-0000-0000-0000-000000000001'
);
insert into public.canvas_nodes (
  id, project_id, type, position_x, position_y, width, height, data,
  asset_id, generation_id, created_by
) values (
  '52000000-0000-0000-0000-000000000002', '21000000-0000-0000-0000-000000000001',
  'image', 900, 50, 100, 100,
  '{"assetId":"91000000-0000-0000-0000-000000000005","mediaRole":"candidate","candidateOf":"51000000-0000-0000-0000-000000000001","candidateIndex":1}',
  '91000000-0000-0000-0000-000000000005', '62000000-0000-0000-0000-000000000002',
  '11000000-0000-0000-0000-000000000001'
);
insert into public.canvas_edges (project_id, source_node_id, target_node_id, type, data)
values (
  '21000000-0000-0000-0000-000000000001', '51000000-0000-0000-0000-000000000001',
  '52000000-0000-0000-0000-000000000002', 'media_candidate', '{"label":"候选"}'
);

select ok(public.swap_media_candidate(
  '21000000-0000-0000-0000-000000000001',
  '51000000-0000-0000-0000-000000000001',
  '52000000-0000-0000-0000-000000000002',
  'preserve_frame'
), '语义编辑候选按保留外框策略采用');
select is((select width::integer from public.canvas_nodes where id = '51000000-0000-0000-0000-000000000001'),
  600, '语义编辑采用后主节点外框宽度不变');
select is((select asset_id::text from public.canvas_nodes where id = '51000000-0000-0000-0000-000000000001'),
  '91000000-0000-0000-0000-000000000005', '语义编辑候选内容进入主节点');
select is((select asset_id::text from public.canvas_nodes where id = '52000000-0000-0000-0000-000000000002'),
  '91000000-0000-0000-0000-000000000004', '语义候选节点保存采用前主内容');
select throws_ok(
  $$select public.swap_media_candidate(
    '21000000-0000-0000-0000-000000000001',
    '51000000-0000-0000-0000-000000000001',
    '52000000-0000-0000-0000-000000000002',
    'unknown_mode'
  )$$,
  'P0001', 'INVALID_CANDIDATE_GEOMETRY_MODE', '未知候选几何策略被拒绝'
);

select * from finish();
rollback;
