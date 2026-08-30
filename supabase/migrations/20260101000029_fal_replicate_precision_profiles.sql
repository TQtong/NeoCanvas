-- ============================================================================
-- 迁移 0029：fal.ai / Replicate 精准编辑工具 Profile
--
-- 每个工具独立建模，providerModel 只能选择 Adapter 内置的受控 endpoint/Profile。
-- 工具模型不包含 generate，因此不会污染首页与普通生成入口。
-- ============================================================================

insert into public.model_catalog
  (key, display_name, provider, modality, capabilities, default_params, sort_order, is_active)
values
  (
    'fal-inpaint-sdxl', 'fal SDXL 局部重绘', 'fal', 'image',
    jsonb_build_object(
      'imageOperations', jsonb_build_array('inpaint'),
      'aspectRatios', jsonb_build_array('1:1','4:3','3:4','16:9','9:16','3:2','2:3'),
      'sizes', '[]'::jsonb, 'maxOutputs', 1, 'supportsNegativePrompt', true,
      'supportsReferenceImages', true, 'requiresReferenceImages', true,
      'supportsImageToVideo', false, 'supportsSeed', true,
      'qualities', '[]'::jsonb, 'isAsync', true, 'supportsWebhook', false,
      'maxInputImages', 1, 'inputFidelityOptions', '[]'::jsonb,
      'upscaleFactors', '[]'::jsonb, 'supportsTransparentOutput', false,
      'maxInputPixels', 16777216
    ),
    jsonb_build_object('count', 1, 'providerModel', 'fal-ai/inpaint'),
    60, true
  ),
  (
    'fal-remove-background-birefnet', 'fal BiRefNet 去背景', 'fal', 'image',
    jsonb_build_object(
      'imageOperations', jsonb_build_array('remove_background'),
      'aspectRatios', jsonb_build_array('1:1','4:3','3:4','16:9','9:16','3:2','2:3'),
      'sizes', '[]'::jsonb, 'maxOutputs', 1, 'supportsNegativePrompt', false,
      'supportsReferenceImages', true, 'requiresReferenceImages', true,
      'supportsImageToVideo', false, 'supportsSeed', false,
      'qualities', '[]'::jsonb, 'isAsync', true, 'supportsWebhook', false,
      'maxInputImages', 1, 'inputFidelityOptions', '[]'::jsonb,
      'upscaleFactors', '[]'::jsonb, 'supportsTransparentOutput', true,
      'maxInputPixels', 16777216
    ),
    jsonb_build_object('count', 1, 'providerModel', 'fal-ai/birefnet'),
    61, true
  ),
  (
    'fal-upscale-topaz', 'fal Topaz 高清放大', 'fal', 'image',
    jsonb_build_object(
      'imageOperations', jsonb_build_array('upscale'),
      'aspectRatios', jsonb_build_array('1:1','4:3','3:4','16:9','9:16','3:2','2:3'),
      'sizes', '[]'::jsonb, 'maxOutputs', 1, 'supportsNegativePrompt', false,
      'supportsReferenceImages', true, 'requiresReferenceImages', true,
      'supportsImageToVideo', false, 'supportsSeed', false,
      'qualities', '[]'::jsonb, 'isAsync', true, 'supportsWebhook', false,
      'maxInputImages', 1, 'inputFidelityOptions', '[]'::jsonb,
      'upscaleFactors', jsonb_build_array(2,4), 'supportsTransparentOutput', false,
      'maxInputPixels', 16777216
    ),
    jsonb_build_object('count', 1, 'providerModel', 'fal-ai/topaz/upscale/image'),
    62, true
  ),
  (
    'replicate-inpaint-sd2', 'Replicate SD2 局部重绘', 'replicate', 'image',
    jsonb_build_object(
      'imageOperations', jsonb_build_array('inpaint'),
      'aspectRatios', jsonb_build_array('1:1','4:3','3:4','16:9','9:16','3:2','2:3'),
      'sizes', '[]'::jsonb, 'maxOutputs', 4, 'supportsNegativePrompt', true,
      'supportsReferenceImages', true, 'requiresReferenceImages', true,
      'supportsImageToVideo', false, 'supportsSeed', true,
      'qualities', '[]'::jsonb, 'isAsync', true, 'supportsWebhook', false,
      'maxInputImages', 1, 'inputFidelityOptions', '[]'::jsonb,
      'upscaleFactors', '[]'::jsonb, 'supportsTransparentOutput', false,
      'maxInputPixels', 4194304
    ),
    jsonb_build_object('count', 1, 'providerModel', 'neocanvas:replicate:inpaint-sd2-v1'),
    63, true
  ),
  (
    'replicate-remove-background', 'Replicate 背景移除', 'replicate', 'image',
    jsonb_build_object(
      'imageOperations', jsonb_build_array('remove_background'),
      'aspectRatios', jsonb_build_array('1:1','4:3','3:4','16:9','9:16','3:2','2:3'),
      'sizes', '[]'::jsonb, 'maxOutputs', 1, 'supportsNegativePrompt', false,
      'supportsReferenceImages', true, 'requiresReferenceImages', true,
      'supportsImageToVideo', false, 'supportsSeed', false,
      'qualities', '[]'::jsonb, 'isAsync', true, 'supportsWebhook', false,
      'maxInputImages', 1, 'inputFidelityOptions', '[]'::jsonb,
      'upscaleFactors', '[]'::jsonb, 'supportsTransparentOutput', true,
      'maxInputPixels', 16777216
    ),
    jsonb_build_object('count', 1, 'providerModel', 'neocanvas:replicate:remove-background-v1'),
    64, true
  ),
  (
    'replicate-upscale-real-esrgan', 'Replicate Real-ESRGAN 放大', 'replicate', 'image',
    jsonb_build_object(
      'imageOperations', jsonb_build_array('upscale'),
      'aspectRatios', jsonb_build_array('1:1','4:3','3:4','16:9','9:16','3:2','2:3'),
      'sizes', '[]'::jsonb, 'maxOutputs', 1, 'supportsNegativePrompt', false,
      'supportsReferenceImages', true, 'requiresReferenceImages', true,
      'supportsImageToVideo', false, 'supportsSeed', false,
      'qualities', '[]'::jsonb, 'isAsync', true, 'supportsWebhook', false,
      'maxInputImages', 1, 'inputFidelityOptions', '[]'::jsonb,
      'upscaleFactors', jsonb_build_array(2,4), 'supportsTransparentOutput', false,
      'maxInputPixels', 8388608
    ),
    jsonb_build_object('count', 1, 'providerModel', 'neocanvas:replicate:real-esrgan-v1'),
    65, true
  )
on conflict (key) do update set
  display_name = excluded.display_name,
  provider = excluded.provider,
  modality = excluded.modality,
  capabilities = excluded.capabilities,
  default_params = excluded.default_params,
  sort_order = excluded.sort_order,
  is_active = excluded.is_active;
