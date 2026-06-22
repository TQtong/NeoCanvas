-- ============================================================================
-- 迁移 0007：Storage 存储桶与访问策略
--
-- 三个桶（第 03 篇第六节）：
--   avatars     —— 用户头像，读公开、写限本人
--   uploads     —— 用户上传的参考图 / 素材，私有，读写限本人
--   generations —— 生成产出，私有，读限本人、写由服务角色完成
-- 路径统一以「用户 id / 项目 id / 资产 id.扩展名」为约定，首段即用户 id，便于隔离。
-- ============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  (
    'avatars',
    'avatars',
    true,
    5242880, -- 5MB
    array['image/png', 'image/jpeg', 'image/webp', 'image/gif']
  ),
  (
    'uploads',
    'uploads',
    false,
    52428800, -- 50MB
    array['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml']
  ),
  (
    'generations',
    'generations',
    false,
    524288000, -- 500MB（容纳视频）
    array[
      'image/png', 'image/jpeg', 'image/webp', 'image/gif',
      'video/mp4', 'video/webm', 'video/quicktime'
    ]
  )
on conflict (id) do nothing;

-- ----------------------------------------------------------------------------
-- avatars：读公开；写 / 改 / 删限本人文件夹（首段路径 = 用户 id）
-- ----------------------------------------------------------------------------
create policy avatars_read_public on storage.objects
  for select using (bucket_id = 'avatars');
create policy avatars_insert_own on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername (name)) [1] = auth.uid ()::text
  );
create policy avatars_update_own on storage.objects
  for update to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername (name)) [1] = auth.uid ()::text
  );
create policy avatars_delete_own on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername (name)) [1] = auth.uid ()::text
  );

-- ----------------------------------------------------------------------------
-- uploads：读写改删均限本人文件夹
-- ----------------------------------------------------------------------------
create policy uploads_read_own on storage.objects
  for select to authenticated
  using (
    bucket_id = 'uploads'
    and (storage.foldername (name)) [1] = auth.uid ()::text
  );
create policy uploads_insert_own on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'uploads'
    and (storage.foldername (name)) [1] = auth.uid ()::text
  );
create policy uploads_update_own on storage.objects
  for update to authenticated
  using (
    bucket_id = 'uploads'
    and (storage.foldername (name)) [1] = auth.uid ()::text
  );
create policy uploads_delete_own on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'uploads'
    and (storage.foldername (name)) [1] = auth.uid ()::text
  );

-- ----------------------------------------------------------------------------
-- generations：读限本人文件夹；写入无策略 → 仅服务角色（绕过 RLS）可写
-- ----------------------------------------------------------------------------
create policy generations_read_own on storage.objects
  for select to authenticated
  using (
    bucket_id = 'generations'
    and (storage.foldername (name)) [1] = auth.uid ()::text
  );
