-- ============================================================================
-- 迁移 0013：放开 uploads 桶以接受本地视频上传
--
-- 背景：迁移 0007 创建 uploads 桶时，allowed_mime_types 只列了图片类型，且尺寸上限
-- 仅 50MB。画布「上传媒体」工具现已支持本地图片与视频（image/video 节点），但用户上传
-- mp4 等视频会被桶级 MIME 白名单拒绝（storage 报「mime type not allowed」）。
--
-- 本迁移：
--   1) 为 uploads 桶补齐视频 MIME（与 generations 桶一致：mp4 / webm / quicktime）；
--   2) 将尺寸上限由 50MB 提升至 200MB，容纳常见的本地短视频素材。
-- 仅改 uploads 桶；avatars / generations 桶不变。
-- ============================================================================

update storage.buckets
set
  allowed_mime_types = array[
    'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml',
    'video/mp4', 'video/webm', 'video/quicktime'
  ],
  file_size_limit = 209715200 -- 200MB
where id = 'uploads';
