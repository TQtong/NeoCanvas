-- ============================================================================
-- 迁移 0011：对象级授权（GRANT）—— 补齐「表级授权 + 行级 RLS」两层模型的下层
--
-- 背景：较新版本的 Supabase CLI 收紧了 public 模式的默认授权——新建表不再自动把
-- DML（SELECT/INSERT/UPDATE/DELETE）授予 anon/authenticated/service_role，仅保留
-- TRUNCATE/REFERENCES/TRIGGER。本项目自 0003 起的业务表依赖两层模型：
--   · GRANT 决定「角色能否触达某张表」（表级，先决条件）；
--   · RLS  决定「能看到/改动哪些行」（行级，第 0006 篇）。
-- 缺失下层 GRANT 时，所有客户端读取（authenticated）与边缘函数读取
-- （service_role —— 绕过 RLS 但不绕过 GRANT）都会直接报
-- `42501 permission denied for table`，对外表现为：最近项目列表空白、模型目录读不到、
-- 「发送/新建」后无法进入设计页、进入即生成不触发。
--
-- 本迁移补齐对象级授权：
--   1) public / private 两个模式的 USAGE（RLS 策略需调用 private 模式的归属函数）；
--   2) 现有 public 表/序列的 DML 授权给 authenticated 与 service_role；
--   3) 设定默认授权，使后续迁移新建的对象自动获得同等授权，避免再次复发。
--
-- 安全说明：
--   · 行级可见性仍完全由 RLS 把关——对没有对应写策略的表（如 model_catalog、
--     generations），authenticated 即便持有表级 DML 也会被 RLS 默认拒绝写入。
--   · service_role 绕过 RLS 但不绕过 GRANT，故必须显式授予表权限。
--   · anon 不参与数据层（所有数据页均在鉴权后渲染），按最小授权原则不授予，
--     与 0009 / 0010 对内部函数的最小授权姿态一致。
-- ============================================================================

-- ---- 1) 模式 USAGE ----------------------------------------------------------
-- public：业务表所在模式；private：RLS 策略调用的归属判定函数所在模式
-- （private.is_project_owner / private.owns_conversation）。查询角色须能触达。
grant usage on schema public to authenticated, service_role;
grant usage on schema private to authenticated, service_role;

-- ---- 2) 现有对象的 DML ------------------------------------------------------
-- 业务表：行级可见性仍由 RLS 把关，此处仅打开表级触达。
grant select, insert, update, delete on all tables in schema public
  to authenticated, service_role;

-- 序列：identity / bigserial 主键写入所需。
grant usage, select on all sequences in schema public
  to authenticated, service_role;

-- ---- 3) 默认授权（面向后续新建对象）----------------------------------------
-- 业务表 owner 为 postgres（迁移以 postgres 运行），故按 postgres 设定默认授权；
-- 后续迁移新建的表/序列将自动获得与上文一致的授权，避免再次出现授权缺口。
alter default privileges for role postgres in schema public
  grant select, insert, update, delete on tables to authenticated, service_role;
alter default privileges for role postgres in schema public
  grant usage, select on sequences to authenticated, service_role;
