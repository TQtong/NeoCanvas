-- ============================================================================
-- 迁移 0012：接入硅基流动（SiliconFlow）作为本地测试提供商
--
-- 目的：让「对话发送 → 进入即生成」在仅持有一把 SiliconFlow 密钥的情况下端到端可用。
--   · 新增一个 SiliconFlow 图像模型 `siliconflow-kolors`（Kwai-Kolors/Kolors，文生图，同步）；
--     providerModel 写入 default_params，供 resolveProviderModel 直接取用（数据驱动，无需改代码）。
--   · 将其设为最靠前（sort_order 最小）的活跃模型，即选择条默认项。
--   · 暂时下架其余需要 OpenAI/Google/Ark 密钥的模型，避免选择条出现「点了必失败」的项。
--   · 把既有项目的 default_model_key 一并指到新模型，使历史项目的对话也走 SiliconFlow。
--
-- 说明：provider 列为 text（非枚举），故无需 ALTER TYPE。审核未配置时为空操作，不拦截。
-- 还原：重新激活其它模型并改回 default_model_key 即可（is_active = true）。
-- ============================================================================

-- ① 新增 / 覆盖 SiliconFlow Kolors 图像模型（文生图，同步）
insert into public.model_catalog
  (key, display_name, provider, modality, capabilities, default_params, sort_order, is_active)
values
  (
    'siliconflow-kolors',
    'Kolors（硅基流动）',
    'siliconflow',
    'image',
    jsonb_build_object(
      'aspectRatios', jsonb_build_array('1:1', '3:4'),
      'sizes', jsonb_build_array(
        jsonb_build_object('width', 1024, 'height', 1024, 'label', '1024×1024'),
        jsonb_build_object('width', 768, 'height', 1024, 'label', '768×1024')
      ),
      'maxOutputs', 4,
      'supportsNegativePrompt', true,
      'supportsReferenceImages', false,
      'supportsImageToVideo', false,
      'supportsSeed', true,
      'qualities', jsonb_build_array(),
      'isAsync', false,
      'supportsWebhook', false
    ),
    jsonb_build_object('aspectRatio', '1:1', 'count', 1, 'providerModel', 'Kwai-Kolors/Kolors'),
    5,
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

-- ② 暂时下架需要其它提供商密钥的模型（本地仅配置了 SiliconFlow 密钥）
update public.model_catalog
  set is_active = false
  where key in ('gpt-image-2', 'nano-banana-pro', 'seedance-2.0');

-- ③ 把既有项目默认模型指到 SiliconFlow，使历史项目的对话也可直接生成
update public.projects
  set default_model_key = 'siliconflow-kolors'
  where default_model_key is distinct from 'siliconflow-kolors';
