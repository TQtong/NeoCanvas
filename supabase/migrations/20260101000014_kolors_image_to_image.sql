-- ============================================================================
-- 迁移 0014：开启 SiliconFlow Kolors 的「图生图（参考图）」能力
--
-- 背景：节点浮动工具条「以此为参考再生成」要做的是——以所选图片为视觉参考，生成一张与之
-- 相似（但每次不同）的新图，并原地替换选中节点。这依赖图生图：把参考图喂给图像模型。
--
-- 现状坑：SiliconFlow 的 /v1/images/generations 对 Kwai-Kolors/Kolors 本就支持 image 参数
-- （base64 data URI 或 URL）做图生图，适配器 siliconflow.ts 也已实现「有参考图即作 image 注入」，
-- 但迁移 0012 把该模型能力画像写成 supportsReferenceImages=false，导致带参考图的请求被
-- pipeline.validateParams 直接拒绝（「当前模型不支持参考图」），参考图从未真正生效——表现为
-- 「换不同参考图，结果与描述都一成不变」。
--
-- 本迁移：将 siliconflow-kolors 的 supportsReferenceImages 置为 true，放行图生图。
-- 仅改该模型的这一项能力，其余能力与默认参数不变。
-- 还原：把该项改回 false 即可。
-- ============================================================================

update public.model_catalog
set capabilities = jsonb_set(capabilities, '{supportsReferenceImages}', 'true'::jsonb, false)
where key = 'siliconflow-kolors';
