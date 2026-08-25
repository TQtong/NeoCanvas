-- ============================================================================
-- 迁移 0026：规范已部署函数源码
--
-- 早期 Windows 本地迁移曾把一条中文异常文案写成问号，并在生成提交函数中保留了只赋值不
-- 读取的局部变量。全新项目的 0021/0023 已是正确源码；本迁移同时兼容已部署环境，通过
-- pg_get_functiondef 原位规范化函数，不改变签名、权限或业务语义。
-- ============================================================================

do $migration$
declare
  v_definition text;
begin
  select pg_get_functiondef(
    'public.create_generation_submission(uuid,uuid,uuid,uuid,uuid,public.modality,text,text,jsonb,text,text,uuid,jsonb,uuid,text,text,integer)'::regprocedure
  ) into v_definition;

  -- 已部署旧版本只把返回 id 存入未读取变量；移除声明与 returning 子句即可保持相同行为。
  v_definition := regexp_replace(
    v_definition,
    E'\n  v_(panel|edge)_id uuid;',
    '',
    'g'
  );
  v_definition := regexp_replace(
    v_definition,
    E'\n      returning id into v_(edge|panel)_id;',
    ';',
    'g'
  );
  execute v_definition;

  select pg_get_functiondef(
    'public.upsert_provider_credential(uuid,text,text,text,text,text,text,boolean)'::regprocedure
  ) into v_definition;
  v_definition := replace(
    v_definition,
    '???????? API Key',
    '新建凭证必须提供 API Key'
  );
  execute v_definition;
end;
$migration$;
