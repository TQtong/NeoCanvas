-- ============================================================================
-- 迁移 0020：展开 SiliconFlow 图片 / 视频模型目录
--
-- 模型 ID 来自 SiliconFlow 官方 /v1/models 接口。每个模型单独登记，节点端先按模态过滤，
-- 再依据是否存在输入素材隐藏必须参考图的图片编辑 / 图生视频模型。
-- ============================================================================

insert into public.model_catalog
  (key, display_name, provider, modality, capabilities, default_params, sort_order, is_active)
values
  (
    'siliconflow-kolors',
    'Kwai-Kolors/Kolors',
    'siliconflow',
    'image',
    jsonb_build_object(
      'aspectRatios', jsonb_build_array('1:1', '3:4', '4:3'),
      'sizes', jsonb_build_array(
        jsonb_build_object('width', 1024, 'height', 1024, 'label', '1024×1024'),
        jsonb_build_object('width', 768, 'height', 1024, 'label', '768×1024')
      ),
      'maxOutputs', 4,
      'supportsNegativePrompt', true,
      'supportsReferenceImages', true,
      'requiresReferenceImages', false,
      'supportsImageToVideo', false,
      'supportsSeed', true,
      'qualities', jsonb_build_array(),
      'isAsync', false,
      'supportsWebhook', false
    ),
    jsonb_build_object('aspectRatio', '1:1', 'count', 1, 'providerModel', 'Kwai-Kolors/Kolors'),
    5,
    true
  ),
  (
    'siliconflow-qwen-image',
    'Qwen/Qwen-Image',
    'siliconflow',
    'image',
    jsonb_build_object(
      'aspectRatios', jsonb_build_array('1:1', '3:4', '4:3'),
      'sizes', jsonb_build_array(),
      'maxOutputs', 4,
      'supportsNegativePrompt', true,
      'supportsReferenceImages', false,
      'requiresReferenceImages', false,
      'supportsImageToVideo', false,
      'supportsSeed', true,
      'qualities', jsonb_build_array(),
      'isAsync', false,
      'supportsWebhook', false
    ),
    jsonb_build_object('aspectRatio', '1:1', 'count', 1, 'providerModel', 'Qwen/Qwen-Image'),
    6,
    true
  ),
  (
    'siliconflow-qwen-image-edit',
    'Qwen/Qwen-Image-Edit',
    'siliconflow',
    'image',
    jsonb_build_object(
      'aspectRatios', jsonb_build_array('1:1', '3:4', '4:3'),
      'sizes', jsonb_build_array(),
      'maxOutputs', 1,
      'supportsNegativePrompt', true,
      'supportsReferenceImages', true,
      'requiresReferenceImages', true,
      'supportsImageToVideo', false,
      'supportsSeed', true,
      'qualities', jsonb_build_array(),
      'isAsync', false,
      'supportsWebhook', false
    ),
    jsonb_build_object('aspectRatio', '1:1', 'count', 1, 'providerModel', 'Qwen/Qwen-Image-Edit'),
    7,
    true
  ),
  (
    'siliconflow-qwen-image-edit-2509',
    'Qwen/Qwen-Image-Edit-2509',
    'siliconflow',
    'image',
    jsonb_build_object(
      'aspectRatios', jsonb_build_array('1:1', '3:4', '4:3'),
      'sizes', jsonb_build_array(),
      'maxOutputs', 1,
      'supportsNegativePrompt', true,
      'supportsReferenceImages', true,
      'requiresReferenceImages', true,
      'supportsImageToVideo', false,
      'supportsSeed', true,
      'qualities', jsonb_build_array(),
      'isAsync', false,
      'supportsWebhook', false
    ),
    jsonb_build_object('aspectRatio', '1:1', 'count', 1, 'providerModel', 'Qwen/Qwen-Image-Edit-2509'),
    8,
    true
  ),
  (
    'siliconflow-z-image',
    'Tongyi-MAI/Z-Image',
    'siliconflow',
    'image',
    jsonb_build_object(
      'aspectRatios', jsonb_build_array('1:1', '3:4', '4:3'),
      'sizes', jsonb_build_array(),
      'maxOutputs', 4,
      'supportsNegativePrompt', true,
      'supportsReferenceImages', false,
      'requiresReferenceImages', false,
      'supportsImageToVideo', false,
      'supportsSeed', true,
      'qualities', jsonb_build_array(),
      'isAsync', false,
      'supportsWebhook', false
    ),
    jsonb_build_object('aspectRatio', '1:1', 'count', 1, 'providerModel', 'Tongyi-MAI/Z-Image'),
    9,
    true
  ),
  (
    'siliconflow-z-image-turbo',
    'Tongyi-MAI/Z-Image-Turbo',
    'siliconflow',
    'image',
    jsonb_build_object(
      'aspectRatios', jsonb_build_array('1:1', '3:4', '4:3'),
      'sizes', jsonb_build_array(),
      'maxOutputs', 4,
      'supportsNegativePrompt', true,
      'supportsReferenceImages', false,
      'requiresReferenceImages', false,
      'supportsImageToVideo', false,
      'supportsSeed', true,
      'qualities', jsonb_build_array(),
      'isAsync', false,
      'supportsWebhook', false
    ),
    jsonb_build_object('aspectRatio', '1:1', 'count', 1, 'providerModel', 'Tongyi-MAI/Z-Image-Turbo'),
    10,
    true
  ),
  (
    'siliconflow-ernie-image-turbo',
    'baidu/ERNIE-Image-Turbo',
    'siliconflow',
    'image',
    jsonb_build_object(
      'aspectRatios', jsonb_build_array('1:1', '3:4', '4:3'),
      'sizes', jsonb_build_array(),
      'maxOutputs', 4,
      'supportsNegativePrompt', true,
      'supportsReferenceImages', false,
      'requiresReferenceImages', false,
      'supportsImageToVideo', false,
      'supportsSeed', true,
      'qualities', jsonb_build_array(),
      'isAsync', false,
      'supportsWebhook', false
    ),
    jsonb_build_object('aspectRatio', '1:1', 'count', 1, 'providerModel', 'baidu/ERNIE-Image-Turbo'),
    11,
    true
  ),
  (
    'siliconflow-wan22-t2v-a14b',
    'Wan-AI/Wan2.2-T2V-A14B',
    'siliconflow',
    'video',
    jsonb_build_object(
      'aspectRatios', jsonb_build_array('16:9', '9:16', '1:1'),
      'sizes', jsonb_build_array(
        jsonb_build_object('width', 1280, 'height', 720, 'label', '1280×720'),
        jsonb_build_object('width', 720, 'height', 1280, 'label', '720×1280'),
        jsonb_build_object('width', 960, 'height', 960, 'label', '960×960')
      ),
      'maxOutputs', 1,
      'supportsNegativePrompt', false,
      'supportsReferenceImages', false,
      'requiresReferenceImages', false,
      'supportsImageToVideo', false,
      'supportsSeed', true,
      'qualities', jsonb_build_array(),
      'isAsync', true,
      'supportsWebhook', false,
      'videoResolutions', jsonb_build_array('720p'),
      'videoDurationRange', jsonb_build_object('min', 5, 'max', 5),
      'supportsMotionStrength', false
    ),
    jsonb_build_object(
      'aspectRatio', '16:9',
      'resolution', '720p',
      'durationSec', 5,
      'fps', 24,
      'providerModel', 'Wan-AI/Wan2.2-T2V-A14B'
    ),
    12,
    true
  ),
  (
    'siliconflow-wan22-i2v-a14b',
    'Wan-AI/Wan2.2-I2V-A14B',
    'siliconflow',
    'video',
    jsonb_build_object(
      'aspectRatios', jsonb_build_array('16:9', '9:16', '1:1'),
      'sizes', jsonb_build_array(
        jsonb_build_object('width', 1280, 'height', 720, 'label', '1280×720'),
        jsonb_build_object('width', 720, 'height', 1280, 'label', '720×1280'),
        jsonb_build_object('width', 960, 'height', 960, 'label', '960×960')
      ),
      'maxOutputs', 1,
      'supportsNegativePrompt', false,
      'supportsReferenceImages', true,
      'requiresReferenceImages', true,
      'supportsImageToVideo', true,
      'supportsSeed', true,
      'qualities', jsonb_build_array(),
      'isAsync', true,
      'supportsWebhook', false,
      'videoResolutions', jsonb_build_array('720p'),
      'videoDurationRange', jsonb_build_object('min', 5, 'max', 5),
      'supportsMotionStrength', false
    ),
    jsonb_build_object(
      'aspectRatio', '16:9',
      'resolution', '720p',
      'durationSec', 5,
      'fps', 24,
      'providerModel', 'Wan-AI/Wan2.2-I2V-A14B'
    ),
    13,
    true
  )
on conflict (key) do update
  set display_name = excluded.display_name,
      provider = excluded.provider,
      modality = excluded.modality,
      capabilities = excluded.capabilities,
      default_params = excluded.default_params,
      sort_order = excluded.sort_order,
      is_active = excluded.is_active;
