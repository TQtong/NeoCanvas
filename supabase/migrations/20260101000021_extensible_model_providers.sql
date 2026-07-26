-- ============================================================================
-- 迁移 0021：可扩展模型供应商
--
-- 新增即梦 / MiniMax 两个原生供应商，并允许用户创建多个 custom:* 供应商实例。
-- provider 是实例标识；adapter 是实际请求协议，两者分离后自定义供应商可复用已支持协议。
-- ============================================================================

alter table public.provider_credentials
  add column adapter text,
  add column website_url text;

update public.provider_credentials set adapter = provider where adapter is null;

alter table public.provider_credentials
  alter column adapter set not null;

alter table public.provider_credentials
  drop constraint if exists provider_credentials_provider_check;

alter table public.provider_credentials
  add constraint provider_credentials_provider_format_check check (
    provider in (
      'openai', 'google', 'volcengine', 'jimeng', 'minimax', 'fal', 'replicate', 'siliconflow'
    )
    or provider ~ '^custom:[a-z0-9][a-z0-9-]{2,47}$'
  ),
  add constraint provider_credentials_adapter_check check (
    adapter in (
      'openai', 'google', 'volcengine', 'jimeng', 'minimax', 'fal', 'replicate', 'siliconflow'
    )
  );

comment on column public.provider_credentials.adapter is
  '实际请求协议适配器；内置供应商与 provider 相同，自定义供应商可选择兼容协议。';
comment on column public.provider_credentials.website_url is
  '供应商官网或开放平台地址，仅用于设置页展示。';

drop function if exists public.upsert_provider_credential(uuid, text, text, text, boolean);

create function public.upsert_provider_credential(
  p_user_id uuid,
  p_provider text,
  p_adapter text,
  p_label text,
  p_website_url text,
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
      v_last4 := case
        when p_adapter = 'jimeng' then right(p_api_key::jsonb ->> 'accessKeyId', 4)
        else right(p_api_key, 4)
      end;
    else
      v_last4 := v_existing.key_last4;
    end if;
    update public.provider_credentials
       set adapter = p_adapter,
           label = nullif(trim(p_label), ''),
           website_url = nullif(trim(p_website_url), ''),
           base_url = nullif(trim(p_base_url), ''),
           key_last4 = v_last4,
           enabled = coalesce(p_enabled, enabled),
           updated_at = now()
     where id = v_existing.id
     returning * into v_row;
  else
    if p_api_key is null or length(p_api_key) = 0 then
      raise exception '新建凭证必须提供 API Key' using errcode = '22023';
    end if;
    v_secret_id := vault.create_secret(
      p_api_key,
      'provider_cred:' || p_user_id::text || ':' || p_provider,
      'NeoCanvas BYOK ' || coalesce(nullif(trim(p_label), ''), p_provider)
    );
    insert into public.provider_credentials
      (user_id, provider, adapter, label, website_url, base_url, key_last4, key_secret_id, enabled)
    values
      (
        p_user_id,
        p_provider,
        p_adapter,
        nullif(trim(p_label), ''),
        nullif(trim(p_website_url), ''),
        nullif(trim(p_base_url), ''),
        case
          when p_adapter = 'jimeng' then right(p_api_key::jsonb ->> 'accessKeyId', 4)
          else right(p_api_key, 4)
        end,
        v_secret_id,
        coalesce(p_enabled, true)
      )
    returning * into v_row;
  end if;

  return jsonb_build_object(
    'id', v_row.id,
    'provider', v_row.provider,
    'adapter', v_row.adapter,
    'label', v_row.label,
    'websiteUrl', v_row.website_url,
    'baseUrl', v_row.base_url,
    'keyLast4', v_row.key_last4,
    'enabled', v_row.enabled,
    'createdAt', v_row.created_at,
    'updatedAt', v_row.updated_at
  );
end;
$$;

comment on function public.upsert_provider_credential is
  '新建/覆盖内置或自定义供应商凭证；明文密钥仅写入 Vault。仅 service_role。';

revoke all on function public.upsert_provider_credential(
  uuid, text, text, text, text, text, text, boolean
) from public, anon, authenticated;
grant execute on function public.upsert_provider_credential(
  uuid, text, text, text, text, text, text, boolean
) to service_role;

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
  v_provider text;
begin
  select key_secret_id, provider into v_secret_id, v_provider
    from public.provider_credentials
   where id = p_id and user_id = p_user_id;
  if not found then
    return false;
  end if;
  if v_provider like 'custom:%' then
    delete from public.model_catalog where user_id = p_user_id and provider = v_provider;
  end if;
  delete from public.provider_credentials where id = p_id and user_id = p_user_id;
  delete from vault.secrets where id = v_secret_id;
  return true;
end;
$$;
