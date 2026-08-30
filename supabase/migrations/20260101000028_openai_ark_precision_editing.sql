-- ============================================================================
-- 迁移 0028：OpenAI 精准编辑能力与 Ark SeedEdit 模型目录
--
-- 仅开放已在对应 Adapter 中完成请求映射和契约测试的操作。模型目录与 Adapter 能力
-- 仍由流水线取交集，旧 Seedream 文生图模型不会因此获得未验证的编辑能力。
-- ============================================================================

update public.model_catalog
   set capabilities = jsonb_set(
     capabilities,
     '{imageOperations}',
     '["generate","semantic_edit","inpaint","outpaint"]'::jsonb,
     true
   )
 where key = 'gpt-image-2'
   and provider = 'openai'
   and modality = 'image';

insert into public.model_catalog
  (key, display_name, provider, modality, capabilities, default_params, sort_order, is_active)
values
  (
    'seededit-3.0',
    '豆包 SeedEdit 3.0',
    'volcengine',
    'image',
    jsonb_build_object(
      'imageOperations', jsonb_build_array('semantic_edit'),
      'aspectRatios', jsonb_build_array('1:1','4:3','3:4','16:9','9:16','3:2','2:3'),
      'sizes', '[]'::jsonb,
      'maxOutputs', 1,
      'supportsNegativePrompt', false,
      'supportsReferenceImages', true,
      'requiresReferenceImages', true,
      'supportsImageToVideo', false,
      'supportsSeed', true,
      'qualities', '[]'::jsonb,
      'isAsync', false,
      'supportsWebhook', false,
      'maxInputImages', 1,
      'inputFidelityOptions', '[]'::jsonb,
      'upscaleFactors', '[]'::jsonb,
      'supportsTransparentOutput', false,
      'maxInputPixels', 16777216
    ),
    jsonb_build_object('aspectRatio', '1:1', 'count', 1),
    41,
    true
  )
on conflict (key) do update set
  display_name = excluded.display_name,
  provider = excluded.provider,
  modality = excluded.modality,
  capabilities = excluded.capabilities,
  default_params = excluded.default_params,
  sort_order = excluded.sort_order,
  is_active = excluded.is_active;

