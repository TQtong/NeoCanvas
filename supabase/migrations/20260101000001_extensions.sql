-- ============================================================================
-- 迁移 0001：扩展与私有 schema
--
-- 启用本项目所需的 PostgreSQL 扩展，并建立一个不经 PostgREST 暴露的 `private`
-- schema，用于承载定时任务调用 Edge Function 的内部逻辑。
-- ============================================================================

-- 生成 UUID（gen_random_uuid 来自 pgcrypto / pg_catalog；显式启用以确保可用）
create extension if not exists "pgcrypto" with schema extensions;

-- 定时任务调度
create extension if not exists "pg_cron";

-- 数据库内发起 HTTP 请求（用于 cron / 触发器调用 Edge Function）
create extension if not exists "pg_net" with schema extensions;

-- 持久消息队列（Supabase Queues）
create extension if not exists "pgmq";

-- 机密管理（存放 Edge Function 基址与服务角色密钥）
create extension if not exists "supabase_vault" with schema vault;

-- 私有 schema：其中对象不加入任何 PostgREST 暴露的发布，客户端不可见。
create schema if not exists private;

comment on schema private is 'NeoCanvas 内部逻辑（定时任务 / Edge 调用），不经 PostgREST 暴露。';
