-- v0.2 精准编辑：允许资产所有者读取已提交的生成暂存对象。
--
-- 生成流水线以 staging/<owner>/<generation>/<attempt>/<asset> 隔离并发落地尝试；
-- 事务提交后资产行会长期引用获胜尝试中的对象，因此读取策略必须同时兼容旧版
-- <owner>/... 与新版 staging/<owner>/... 两种路径。写入仍只允许 service_role。

drop policy if exists generations_read_own on storage.objects;

create policy generations_read_own on storage.objects
  for select to authenticated
  using (
    bucket_id = 'generations'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or (
        (storage.foldername(name))[1] = 'staging'
        and (storage.foldername(name))[2] = auth.uid()::text
      )
    )
  );
