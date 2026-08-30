-- ============================================================================
-- 迁移 0031：Google / MiniMax / SiliconFlow 语义编辑能力收口
--
-- 模型目录只能缩小 Adapter 已验证的协议能力，不能把普通生成模型乐观标记为编辑模型。
-- Google 与 MiniMax 仅开放语义编辑；SiliconFlow 只有两个 Qwen Image Edit 端点开放编辑。
-- ============================================================================

update public.model_catalog
   set capabilities = capabilities || jsonb_build_object(
         'imageOperations', jsonb_build_array('generate', 'semantic_edit'),
         'aspectRatios', jsonb_build_array('1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3'),
         'sizes', jsonb_build_array(
           jsonb_build_object('width', 1024, 'height', 1024, 'label', '1K'),
           jsonb_build_object('width', 2048, 'height', 2048, 'label', '2K'),
           jsonb_build_object('width', 4096, 'height', 4096, 'label', '4K')
         ),
         'maxOutputs', 1,
         'supportsReferenceImages', true,
         'maxInputImages', 14,
         'inputFidelityOptions', '[]'::jsonb,
         'upscaleFactors', '[]'::jsonb,
         'supportsTransparentOutput', false,
         'maxInputPixels', 16777216
       ),
       default_params = default_params || jsonb_build_object(
         'providerModel', 'gemini-3-pro-image',
         'sizePreset', '2k',
         'count', 1
       )
 where key = 'nano-banana-pro'
   and provider = 'google'
   and modality = 'image';

update public.model_catalog
   set capabilities = capabilities || jsonb_build_object(
         'imageOperations', jsonb_build_array('generate', 'semantic_edit'),
         'maxInputImages', 1,
         'inputFidelityOptions', '[]'::jsonb,
         'upscaleFactors', '[]'::jsonb,
         'supportsTransparentOutput', false,
         'maxInputPixels', 16777216
       )
 where key in ('minimax-image-01', 'minimax-image-01-live')
   and provider = 'minimax'
   and modality = 'image';

-- 普通 SiliconFlow 图片模型不再因为历史 supportsReferenceImages 标记而进入编辑选择器。
update public.model_catalog
   set capabilities = capabilities || jsonb_build_object(
         'imageOperations', jsonb_build_array('generate'),
         'supportsReferenceImages', false,
         'requiresReferenceImages', false,
         'maxOutputs', case when key = 'siliconflow-kolors' then 4 else 1 end,
         'maxInputImages', 0,
         'inputFidelityOptions', '[]'::jsonb,
         'upscaleFactors', '[]'::jsonb,
         'supportsTransparentOutput', false,
         'maxInputPixels', 16777216
       )
 where provider = 'siliconflow'
   and modality = 'image'
   and key not in ('siliconflow-qwen-image-edit', 'siliconflow-qwen-image-edit-2509');

-- 两个编辑模型只服务画布编辑入口，不能出现在首页或普通生成模型列表中。
update public.model_catalog
   set capabilities = capabilities || jsonb_build_object(
         'imageOperations', jsonb_build_array('semantic_edit'),
         'supportsReferenceImages', true,
         'requiresReferenceImages', true,
         'maxOutputs', 1,
         'maxInputImages',
           case when key = 'siliconflow-qwen-image-edit-2509' then 3 else 1 end,
         'inputFidelityOptions', '[]'::jsonb,
         'upscaleFactors', '[]'::jsonb,
         'supportsTransparentOutput', false,
         'maxInputPixels', 16777216
       )
 where key in ('siliconflow-qwen-image-edit', 'siliconflow-qwen-image-edit-2509')
   and provider = 'siliconflow'
   and modality = 'image';

