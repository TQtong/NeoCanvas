-- ============================================================================
-- 种子数据：model_catalog
--
-- 主页选择条展示三个具体模型（GPT Image 2 默认、Seedance 2.0、Nano Banana Pro）。
-- 另登记 Seedream 作为 is_active=false 的预留模型，演示「数据驱动扩展」而不改 UI。
-- capabilities / default_params 的字段名与 types/models.ts 对齐（camelCase）。
-- ============================================================================

insert into public.model_catalog
  (key, display_name, provider, modality, capabilities, default_params, sort_order, is_active)
values
  -- ① GPT Image 2（OpenAI，图像，默认选中）
  (
    'gpt-image-2',
    'GPT Image 2',
    'openai',
    'image',
    jsonb_build_object(
      'aspectRatios', jsonb_build_array('1:1', '3:2', '2:3'),
      'sizes', jsonb_build_array(
        jsonb_build_object('width', 1024, 'height', 1024, 'label', '1024×1024'),
        jsonb_build_object('width', 1536, 'height', 1024, 'label', '1536×1024'),
        jsonb_build_object('width', 1024, 'height', 1536, 'label', '1024×1536')
      ),
      'maxOutputs', 4,
      'supportsNegativePrompt', false,
      'supportsReferenceImages', true,
      'supportsImageToVideo', false,
      'supportsSeed', false,
      'qualities', jsonb_build_array('low', 'medium', 'high', 'auto'),
      'isAsync', false,
      'supportsWebhook', false
    ),
    jsonb_build_object('aspectRatio', '1:1', 'count', 1, 'quality', 'high'),
    10,
    true
  ),
  -- ② Seedance 2.0（火山方舟 Ark，视频，异步）
  (
    'seedance-2.0',
    'Seedance 2.0',
    'volcengine',
    'video',
    jsonb_build_object(
      'aspectRatios', jsonb_build_array('16:9', '9:16', '1:1'),
      'sizes', jsonb_build_array(),
      'maxOutputs', 1,
      'supportsNegativePrompt', false,
      'supportsReferenceImages', true,
      'supportsImageToVideo', true,
      'supportsSeed', true,
      'qualities', jsonb_build_array(),
      'isAsync', true,
      'supportsWebhook', false,
      'videoResolutions', jsonb_build_array('480p', '720p', '1080p'),
      'videoDurationRange', jsonb_build_object('min', 3, 'max', 12),
      'supportsMotionStrength', true
    ),
    jsonb_build_object('resolution', '720p', 'durationSec', 5, 'fps', 24, 'aspectRatio', '16:9'),
    20,
    true
  ),
  -- ③ Nano Banana Pro（Google，图像）
  (
    'nano-banana-pro',
    'Nano Banana Pro',
    'google',
    'image',
    jsonb_build_object(
      'aspectRatios', jsonb_build_array('1:1', '4:3', '3:4', '16:9', '9:16'),
      'sizes', jsonb_build_array(),
      'maxOutputs', 4,
      'supportsNegativePrompt', false,
      'supportsReferenceImages', true,
      'supportsImageToVideo', false,
      'supportsSeed', true,
      'qualities', jsonb_build_array('high'),
      'isAsync', false,
      'supportsWebhook', false
    ),
    jsonb_build_object('aspectRatio', '1:1', 'count', 1),
    30,
    true
  ),
  -- ④ Seedream（火山方舟 Ark，图像，预留：登记但不上架）
  (
    'seedream-3.0',
    'Seedream 3.0',
    'volcengine',
    'image',
    jsonb_build_object(
      'aspectRatios', jsonb_build_array('1:1', '4:3', '3:4', '16:9', '9:16'),
      'sizes', jsonb_build_array(),
      'maxOutputs', 4,
      'supportsNegativePrompt', true,
      'supportsReferenceImages', true,
      'supportsImageToVideo', false,
      'supportsSeed', true,
      'qualities', jsonb_build_array(),
      'isAsync', false,
      'supportsWebhook', false
    ),
    jsonb_build_object('aspectRatio', '1:1', 'count', 1),
    40,
    false
  )
on conflict (key) do update
  set display_name = excluded.display_name,
      provider = excluded.provider,
      modality = excluded.modality,
      capabilities = excluded.capabilities,
      default_params = excluded.default_params,
      sort_order = excluded.sort_order,
      is_active = excluded.is_active;
