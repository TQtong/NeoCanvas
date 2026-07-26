-- ============================================================================
-- 迁移 0022：即梦 / MiniMax 官方图片与视频模型目录
-- ============================================================================

insert into public.model_catalog
  (key, display_name, provider, modality, capabilities, default_params, sort_order, is_active)
values
  (
    'jimeng-image-4.0', '即梦图片生成 4.0', 'jimeng', 'image',
    jsonb_build_object(
      'aspectRatios', jsonb_build_array('1:1','16:9','9:16','4:3','3:4','3:2','2:3'),
      'sizes', '[]'::jsonb, 'maxOutputs', 15, 'supportsNegativePrompt', false,
      'supportsReferenceImages', true, 'supportsImageToVideo', false, 'supportsSeed', true,
      'qualities', jsonb_build_array('auto','high'), 'isAsync', true, 'supportsWebhook', false
    ),
    jsonb_build_object('aspectRatio', '1:1', 'count', 1, 'providerModel', 'jimeng_t2i_v40'),
    45, true
  ),
  (
    'jimeng-video-3.0-720p', '即梦视频生成 3.0 720P', 'jimeng', 'video',
    jsonb_build_object(
      'aspectRatios', jsonb_build_array('16:9','9:16','1:1','4:3','3:4'),
      'sizes', '[]'::jsonb, 'maxOutputs', 1, 'supportsNegativePrompt', false,
      'supportsReferenceImages', false, 'supportsImageToVideo', false, 'supportsSeed', true,
      'qualities', '[]'::jsonb, 'isAsync', true, 'supportsWebhook', false,
      'videoResolutions', jsonb_build_array('720p'),
      'videoDurationRange', jsonb_build_object('min', 5, 'max', 10),
      'supportsMotionStrength', false, 'supportsKeyframeSequence', false
    ),
    jsonb_build_object(
      'aspectRatio', '16:9', 'resolution', '720p', 'durationSec', 5,
      'fps', 24, 'providerModel', 'jimeng_t2v_v30_720p'
    ),
    46, true
  ),
  (
    'jimeng-video-3.0-first-last', '即梦视频 3.0 首尾帧', 'jimeng', 'video',
    jsonb_build_object(
      'aspectRatios', jsonb_build_array('16:9','9:16','1:1','4:3','3:4'),
      'sizes', '[]'::jsonb, 'maxOutputs', 1, 'supportsNegativePrompt', false,
      'supportsReferenceImages', true, 'requiresReferenceImages', true,
      'supportsImageToVideo', true, 'supportsSeed', true, 'qualities', '[]'::jsonb,
      'isAsync', true, 'supportsWebhook', false,
      'videoResolutions', jsonb_build_array('720p'),
      'videoDurationRange', jsonb_build_object('min', 5, 'max', 10),
      'supportsMotionStrength', false, 'supportsKeyframeSequence', true
    ),
    jsonb_build_object(
      'aspectRatio', '16:9', 'resolution', '720p', 'durationSec', 5,
      'fps', 24, 'providerModel', 'jimeng_i2v_first_tail_v30'
    ),
    47, true
  ),
  (
    'minimax-image-01', 'MiniMax Image 01', 'minimax', 'image',
    jsonb_build_object(
      'aspectRatios', jsonb_build_array('1:1','16:9','9:16','4:3','3:4','3:2','2:3','21:9'),
      'sizes', '[]'::jsonb, 'maxOutputs', 9, 'supportsNegativePrompt', false,
      'supportsReferenceImages', true, 'supportsImageToVideo', false, 'supportsSeed', true,
      'qualities', jsonb_build_array('auto'), 'isAsync', false, 'supportsWebhook', false
    ),
    jsonb_build_object('aspectRatio', '1:1', 'count', 1, 'providerModel', 'image-01'),
    48, true
  ),
  (
    'minimax-image-01-live', 'MiniMax Image 01 Live', 'minimax', 'image',
    jsonb_build_object(
      'aspectRatios', jsonb_build_array('1:1','16:9','9:16','4:3','3:4','3:2','2:3'),
      'sizes', '[]'::jsonb, 'maxOutputs', 9, 'supportsNegativePrompt', false,
      'supportsReferenceImages', true, 'supportsImageToVideo', false, 'supportsSeed', true,
      'qualities', jsonb_build_array('auto'), 'isAsync', false, 'supportsWebhook', false
    ),
    jsonb_build_object('aspectRatio', '1:1', 'count', 1, 'providerModel', 'image-01-live'),
    49, true
  ),
  (
    'minimax-hailuo-2.3', 'MiniMax Hailuo 2.3', 'minimax', 'video',
    jsonb_build_object(
      'aspectRatios', jsonb_build_array('16:9','9:16'), 'sizes', '[]'::jsonb,
      'maxOutputs', 1, 'supportsNegativePrompt', false, 'supportsReferenceImages', true,
      'supportsImageToVideo', true, 'supportsSeed', false, 'qualities', '[]'::jsonb,
      'isAsync', true, 'supportsWebhook', false,
      'videoResolutions', jsonb_build_array('768p','1080p'),
      'videoDurationRange', jsonb_build_object('min', 6, 'max', 10),
      'supportsMotionStrength', false, 'supportsKeyframeSequence', true
    ),
    jsonb_build_object(
      'aspectRatio', '16:9', 'resolution', '1080p', 'durationSec', 6,
      'fps', 24, 'providerModel', 'MiniMax-Hailuo-2.3'
    ),
    50, true
  ),
  (
    'minimax-hailuo-2.3-fast', 'MiniMax Hailuo 2.3 Fast', 'minimax', 'video',
    jsonb_build_object(
      'aspectRatios', jsonb_build_array('16:9','9:16'), 'sizes', '[]'::jsonb,
      'maxOutputs', 1, 'supportsNegativePrompt', false, 'supportsReferenceImages', true,
      'supportsImageToVideo', true, 'supportsSeed', false, 'qualities', '[]'::jsonb,
      'isAsync', true, 'supportsWebhook', false,
      'videoResolutions', jsonb_build_array('768p','1080p'),
      'videoDurationRange', jsonb_build_object('min', 6, 'max', 10),
      'supportsMotionStrength', false, 'supportsKeyframeSequence', false
    ),
    jsonb_build_object(
      'aspectRatio', '16:9', 'resolution', '768p', 'durationSec', 6,
      'fps', 24, 'providerModel', 'MiniMax-Hailuo-2.3-Fast'
    ),
    51, true
  )
on conflict (key) do update set
  display_name = excluded.display_name,
  provider = excluded.provider,
  modality = excluded.modality,
  capabilities = excluded.capabilities,
  default_params = excluded.default_params,
  sort_order = excluded.sort_order,
  is_active = excluded.is_active;
