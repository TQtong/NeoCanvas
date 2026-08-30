-- ============================================================================
-- 迁移 0030：即梦精准编辑官方 Action Profile
--
-- 普通图片 4.0 只负责生成/语义编辑；重绘、扩图、去背景和超分各自独立登记，
-- providerModel 与 Edge Adapter 的受控 Profile 逐字一致，工具条目不进入普通生成入口。
-- ============================================================================

update public.model_catalog
   set capabilities = jsonb_build_object(
         'imageOperations', jsonb_build_array('generate', 'semantic_edit'),
         'aspectRatios', jsonb_build_array('1:1','16:9','9:16','4:3','3:4','3:2','2:3'),
         'sizes', '[]'::jsonb,
         'maxOutputs', 4,
         'supportsNegativePrompt', false,
         'supportsReferenceImages', true,
         'requiresReferenceImages', false,
         'supportsImageToVideo', false,
         'supportsSeed', true,
         'qualities', jsonb_build_array('auto','high'),
         'isAsync', true,
         'supportsWebhook', false,
         'maxInputImages', 10,
         'inputFidelityOptions', jsonb_build_array('standard','high'),
         'upscaleFactors', '[]'::jsonb,
         'supportsTransparentOutput', false,
         'maxInputPixels', 16777216
       ),
       default_params = jsonb_build_object(
         'aspectRatio', '1:1', 'count', 1, 'quality', 'high',
         'providerModel', 'jimeng_t2i_v40'
       )
 where key = 'jimeng-image-4.0'
   and provider = 'jimeng';

insert into public.model_catalog
  (key, display_name, provider, modality, capabilities, default_params, sort_order, is_active)
values
  (
    'jimeng-inpaint', '即梦交互局部重绘', 'jimeng', 'image',
    jsonb_build_object(
      'imageOperations', jsonb_build_array('inpaint'),
      'aspectRatios', jsonb_build_array('1:1','16:9','9:16','4:3','3:4','3:2','2:3'),
      'sizes', '[]'::jsonb, 'maxOutputs', 1, 'supportsNegativePrompt', false,
      'supportsReferenceImages', true, 'requiresReferenceImages', true,
      'supportsImageToVideo', false, 'supportsSeed', true,
      'qualities', '[]'::jsonb, 'isAsync', true, 'supportsWebhook', false,
      'maxInputImages', 1, 'inputFidelityOptions', '[]'::jsonb,
      'upscaleFactors', '[]'::jsonb, 'supportsTransparentOutput', false,
      'maxInputPixels', 16777216
    ),
    jsonb_build_object(
      'count', 1, 'providerModel', 'jimeng_image2image_dream_inpaint'
    ),
    66, true
  ),
  (
    'jimeng-outpaint', '即梦四边智能扩图', 'jimeng', 'image',
    jsonb_build_object(
      'imageOperations', jsonb_build_array('outpaint'),
      'aspectRatios', jsonb_build_array('1:1','16:9','9:16','4:3','3:4','3:2','2:3'),
      'sizes', '[]'::jsonb, 'maxOutputs', 1, 'supportsNegativePrompt', false,
      'supportsReferenceImages', true, 'requiresReferenceImages', true,
      'supportsImageToVideo', false, 'supportsSeed', true,
      'qualities', '[]'::jsonb, 'isAsync', false, 'supportsWebhook', false,
      'maxInputImages', 1, 'inputFidelityOptions', '[]'::jsonb,
      'upscaleFactors', '[]'::jsonb, 'supportsTransparentOutput', false,
      'maxInputPixels', 4194304
    ),
    jsonb_build_object('count', 1, 'providerModel', 'i2i_outpainting'),
    67, true
  ),
  (
    'jimeng-remove-background', '即梦主体去背景', 'jimeng', 'image',
    jsonb_build_object(
      'imageOperations', jsonb_build_array('remove_background'),
      'aspectRatios', jsonb_build_array('1:1','16:9','9:16','4:3','3:4','3:2','2:3'),
      'sizes', '[]'::jsonb, 'maxOutputs', 1, 'supportsNegativePrompt', false,
      'supportsReferenceImages', true, 'requiresReferenceImages', true,
      'supportsImageToVideo', false, 'supportsSeed', false,
      'qualities', '[]'::jsonb, 'isAsync', false, 'supportsWebhook', false,
      'maxInputImages', 1, 'inputFidelityOptions', '[]'::jsonb,
      'upscaleFactors', '[]'::jsonb, 'supportsTransparentOutput', true,
      'maxInputPixels', 16777216
    ),
    jsonb_build_object('count', 1, 'providerModel', 'entity_seg'),
    68, true
  ),
  (
    'jimeng-upscale', '即梦 2×/4× 高清放大', 'jimeng', 'image',
    jsonb_build_object(
      'imageOperations', jsonb_build_array('upscale'),
      'aspectRatios', jsonb_build_array('1:1','16:9','9:16','4:3','3:4','3:2','2:3'),
      'sizes', '[]'::jsonb, 'maxOutputs', 1, 'supportsNegativePrompt', false,
      'supportsReferenceImages', true, 'requiresReferenceImages', true,
      'supportsImageToVideo', false, 'supportsSeed', false,
      'qualities', jsonb_build_array('high'), 'isAsync', false, 'supportsWebhook', false,
      'maxInputImages', 1, 'inputFidelityOptions', '[]'::jsonb,
      'upscaleFactors', jsonb_build_array(2,4), 'supportsTransparentOutput', false,
      'maxInputPixels', 16777216
    ),
    jsonb_build_object('count', 1, 'quality', 'high', 'providerModel', 'lens_nnsr2_pic_common'),
    69, true
  )
on conflict (key) do update set
  display_name = excluded.display_name,
  provider = excluded.provider,
  modality = excluded.modality,
  capabilities = excluded.capabilities,
  default_params = excluded.default_params,
  sort_order = excluded.sort_order,
  is_active = excluded.is_active;
