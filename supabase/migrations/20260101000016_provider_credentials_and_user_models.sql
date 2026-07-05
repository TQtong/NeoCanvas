-- ============================================================================
-- 迁移 0016：BYOK 模型提供商凭证 + 用户自有模型
--
-- 目标：让密钥不再只能经 `supabase secrets set` / 环境变量配置，而是每个登录用户可在
-- 前端自助配置自己的「模型提供商 + API Key」（BYOK），并管理自己的模型条目。
--
-- 安全红线（CLAUDE.md「密钥不出边缘」）：
--   · 明文 Key 永不入库可读列——仅以 Vault 加密存储；库表只留 key_last4（脱敏展示）
--     与 key_secret_id（指向 vault.secrets，无 vault 访问无法解密）。
--   · 凭证的写入 / 解密只经下方三个 SECURITY DEFINER RPC，且 RPC 仅授予 service_role
--     （即只在 Edge Functions 内可调）；authenticated / anon 一律 revoke，杜绝明文经
--     PostgREST 外泄。
--   · 客户端只能 SELECT 凭证元数据（provider / base_url / last4 / enabled），用于展示。
--
-- 解析优先级（见 _shared/credentials.ts）：用户凭证（启用）→ 环境变量回退 → 不可用。
-- 故本迁移不破坏现有「以 env 提供全局默认 Key」的本地可用性。
-- ============================================================================

-- ----------------------------------------------------------------------------
-- A) 提供商凭证表（每用户，RLS 隔离，仅存 Vault 引用与脱敏尾号）
-- ----------------------------------------------------------------------------
create table public.provider_credentials (
  id uuid primary key default gen_random_uuid (),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- 取值须与 types/enums.ts 的 PROVIDERS 逐字一致（适配器路由键）
  provider text not null check (
    provider in ('openai', 'google', 'volcengine', 'fal', 'replicate', 'siliconflow')
  ),
  -- 可选展示标签（如「我的 OpenAI 工作号」）；空则前端按 provider 名展示
  label text,
  -- 可选自定义端点（OpenAI 兼容代理 / 自建网关）；空则适配器用各自默认端点
  base_url text,
  -- 脱敏：仅保存末 4 位用于「••••abcd」展示，绝不保存明文
  key_last4 text not null,
  -- 指向 vault.secrets.id 的引用；客户端拿到也无法解密（无 vault 访问）
  key_secret_id uuid not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- 一个用户每个 provider 至多一条凭证
  unique (user_id, provider)
);
comment on table public.provider_credentials is
  '用户自带（BYOK）模型提供商凭证：明文 Key 存于 Vault，本表仅留脱敏尾号与 vault 引用。';
comment on column public.provider_credentials.key_secret_id is
  '指向 vault.secrets.id；解密仅经 public.get_provider_api_key（service_role）在边缘内进行。';

create index provider_credentials_user_idx on public.provider_credentials (user_id);

-- RLS：本人只读自己的凭证元数据；写入恒经 service_role RPC（绕过 RLS），不开放客户端写策略
alter table public.provider_credentials enable row level security;
create policy provider_credentials_select_own on public.provider_credentials
  for select to authenticated using (user_id = auth.uid ());

-- 纵深防御：即便 0011 的默认授权把 DML 授予了 authenticated，也显式收回写权限
-- （无写 RLS 策略本就拒绝，这里再封一层），仅保留 SELECT。
revoke insert, update, delete on public.provider_credentials from authenticated;

-- ----------------------------------------------------------------------------
-- B) model_catalog 扩展为「内置 + 用户自有」
--    新增 user_id：NULL = 内置种子（全局只读）；非空 = 该用户自有模型。
--    key 仍保留既有「全局唯一」约束（model_catalog_key_key），以保证生成流水线各处
--    `where key = model_key` 的单行查找不产生歧义（队列 / 轮询 / 回调无需穿透 owner）。
-- ----------------------------------------------------------------------------
alter table public.model_catalog
  add column user_id uuid references auth.users (id) on delete cascade;
comment on column public.model_catalog.user_id is
  'NULL=内置种子（全局只读）；非空=该用户自有模型。key 仍全局唯一。';

create index model_catalog_user_idx on public.model_catalog (user_id);

-- 重建可见性：内置已上架行人人可读 + 自有行（含未上架，便于本人管理）本人可读
drop policy if exists model_catalog_select_active on public.model_catalog;
create policy model_catalog_select on public.model_catalog
  for select to authenticated
  using ((user_id is null and is_active = true) or user_id = auth.uid ());

-- 自有模型增删改（内置行 user_id 为 NULL，with check 使其无法被客户端写动）
create policy model_catalog_insert_own on public.model_catalog
  for insert to authenticated with check (user_id = auth.uid ());
create policy model_catalog_update_own on public.model_catalog
  for update to authenticated using (user_id = auth.uid ()) with check (user_id = auth.uid ());
create policy model_catalog_delete_own on public.model_catalog
  for delete to authenticated using (user_id = auth.uid ());

-- ----------------------------------------------------------------------------
-- C) 凭证写入 / 解密 RPC（SECURITY DEFINER，仅 service_role 可执行）
--    仿 private.get_secret（0009）：以 postgres 属主在定义者上下文访问 vault。
-- ----------------------------------------------------------------------------

-- 新建或覆盖一条凭证：有则改（key 为空表示保留原 key，仅改 base_url / enabled），无则建。
-- 返回脱敏后的行（绝不含明文 / 解密 Key）。
create or replace function public.upsert_provider_credential(
  p_user_id uuid,
  p_provider text,
  p_base_url text,
  p_api_key text,
  p_enabled boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_existing public.provider_credentials;
  v_secret_id uuid;
  v_last4 text;
  v_row public.provider_credentials;
begin
  select * into v_existing
    from public.provider_credentials
   where user_id = p_user_id and provider = p_provider;

  if found then
    v_secret_id := v_existing.key_secret_id;
    if p_api_key is not null and length(p_api_key) > 0 then
      perform vault.update_secret(v_secret_id, p_api_key);
      v_last4 := right(p_api_key, 4);
    else
      v_last4 := v_existing.key_last4; -- 未改 Key：沿用既有尾号
    end if;
    update public.provider_credentials
       set base_url = p_base_url,
           key_last4 = v_last4,
           enabled = coalesce(p_enabled, enabled),
           updated_at = now()
     where id = v_existing.id
     returning * into v_row;
  else
    if p_api_key is null or length(p_api_key) = 0 then
      raise exception '新建凭证必须提供 API Key' using errcode = '22023';
    end if;
    -- vault 机密名按 user+provider 唯一编址，便于排障与一致性
    v_secret_id := vault.create_secret(
      p_api_key,
      'provider_cred:' || p_user_id::text || ':' || p_provider,
      'NeoCanvas BYOK ' || p_provider
    );
    insert into public.provider_credentials
      (user_id, provider, base_url, key_last4, key_secret_id, enabled)
    values
      (p_user_id, p_provider, p_base_url, right(p_api_key, 4), v_secret_id, coalesce(p_enabled, true))
    returning * into v_row;
  end if;

  return jsonb_build_object(
    'id', v_row.id,
    'provider', v_row.provider,
    'label', v_row.label,
    'baseUrl', v_row.base_url,
    'keyLast4', v_row.key_last4,
    'enabled', v_row.enabled,
    'createdAt', v_row.created_at,
    'updatedAt', v_row.updated_at
  );
end;
$$;
comment on function public.upsert_provider_credential is
  '新建/覆盖用户提供商凭证：明文 Key 写入 Vault，库表只留尾号与引用；返回脱敏行。仅 service_role。';

-- 删除一条凭证（连同其 Vault 机密）。校验归属，幂等返回是否删除。
create or replace function public.delete_provider_credential(
  p_user_id uuid,
  p_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_secret_id uuid;
begin
  select key_secret_id into v_secret_id
    from public.provider_credentials
   where id = p_id and user_id = p_user_id;
  if not found then
    return false;
  end if;
  delete from public.provider_credentials where id = p_id and user_id = p_user_id;
  delete from vault.secrets where id = v_secret_id;
  return true;
end;
$$;
comment on function public.delete_provider_credential is
  '删除用户的一条提供商凭证及其 Vault 机密。仅 service_role。';

-- 解析某用户某 provider 的明文 Key（供边缘在 buildModelContext 内取用）。无则返回空行。
create or replace function public.get_provider_api_key(
  p_user_id uuid,
  p_provider text
)
returns table (api_key text, base_url text, enabled boolean)
language sql
security definer
stable
set search_path = public, vault
as $$
  select v.decrypted_secret, c.base_url, c.enabled
    from public.provider_credentials c
    join vault.decrypted_secrets v on v.id = c.key_secret_id
   where c.user_id = p_user_id and c.provider = p_provider
   limit 1;
$$;
comment on function public.get_provider_api_key is
  '解密返回用户某 provider 的明文 Key + base_url + enabled，供 Edge Functions 解析。仅 service_role。';

-- 三个 RPC 一律仅授予 service_role；杜绝明文 Key 经 anon / authenticated 经 PostgREST 外泄。
revoke all on function public.upsert_provider_credential(uuid, text, text, text, boolean)
  from public, anon, authenticated;
revoke all on function public.delete_provider_credential(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.get_provider_api_key(uuid, text)
  from public, anon, authenticated;
grant execute on function public.upsert_provider_credential(uuid, text, text, text, boolean)
  to service_role;
grant execute on function public.delete_provider_credential(uuid, uuid)
  to service_role;
grant execute on function public.get_provider_api_key(uuid, text)
  to service_role;
