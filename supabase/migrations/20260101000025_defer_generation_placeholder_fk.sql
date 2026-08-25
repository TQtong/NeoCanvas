-- 本地或已升级到 0023 的环境补充循环外键延迟属性；全新安装在 0023 已完成同一设置。
alter table public.generations
  alter constraint generations_placeholder_node_id_fkey deferrable initially deferred;
