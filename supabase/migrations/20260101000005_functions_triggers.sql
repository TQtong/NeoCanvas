-- ============================================================================
-- 迁移 0005：数据库函数与触发器
--
-- 把贴近数据的逻辑沉到数据库（第 03 篇第八节）：更新时间维护、注册建档、项目
-- 活跃度刷新、生成状态机守卫，以及供 RLS 复用的归属判定函数。
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 通用：更新前自动刷新 updated_at
-- ----------------------------------------------------------------------------
create or replace function public.handle_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

comment on function public.handle_updated_at is '更新前将 updated_at 置为当前时间。';

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.handle_updated_at();

create trigger projects_set_updated_at
  before update on public.projects
  for each row execute function public.handle_updated_at();

create trigger conversations_set_updated_at
  before update on public.conversations
  for each row execute function public.handle_updated_at();

create trigger canvas_nodes_set_updated_at
  before update on public.canvas_nodes
  for each row execute function public.handle_updated_at();

create trigger generations_set_updated_at
  before update on public.generations
  for each row execute function public.handle_updated_at();

-- ----------------------------------------------------------------------------
-- 注册建档：auth.users 插入后在 profiles 自动建行
-- ----------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name, avatar_url, locale)
  values (
    new.id,
    coalesce(
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name',
      split_part(new.email, '@', 1)
    ),
    new.raw_user_meta_data ->> 'avatar_url',
    coalesce(new.raw_user_meta_data ->> 'locale', 'zh-CN')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

comment on function public.handle_new_user is '新用户注册后自动在 profiles 建档。';

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ----------------------------------------------------------------------------
-- 项目活跃度：节点 / 边 / 消息变更时刷新所属 projects.updated_at
-- ----------------------------------------------------------------------------
create or replace function public.touch_project_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project_id uuid;
begin
  if tg_table_name = 'messages' then
    -- 消息无 project_id，经会话反查
    select c.project_id
      into v_project_id
      from public.conversations c
     where c.id = coalesce(new.conversation_id, old.conversation_id);
  else
    -- canvas_nodes / canvas_edges 自带 project_id
    v_project_id := coalesce(new.project_id, old.project_id);
  end if;

  if v_project_id is not null then
    update public.projects
       set updated_at = now()
     where id = v_project_id;
  end if;

  return coalesce(new, old);
end;
$$;

comment on function public.touch_project_activity is '画布 / 会话变更时刷新所属项目的更新时间，驱动「最近项目」排序。';

create trigger canvas_nodes_touch_project
  after insert or update or delete on public.canvas_nodes
  for each row execute function public.touch_project_activity();

create trigger canvas_edges_touch_project
  after insert or update or delete on public.canvas_edges
  for each row execute function public.touch_project_activity();

create trigger messages_touch_project
  after insert or update or delete on public.messages
  for each row execute function public.touch_project_activity();

-- ----------------------------------------------------------------------------
-- 生成状态机守卫：禁止从终态转出，防止迟到事件重复落库（第 06 篇第九节）
-- ----------------------------------------------------------------------------
create or replace function public.guard_generation_status()
returns trigger
language plpgsql
as $$
begin
  if old.status in ('succeeded', 'failed', 'cancelled')
     and new.status is distinct from old.status then
    raise exception
      'generation % 已处于终态 %，不可转为 %',
      old.id, old.status, new.status
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

comment on function public.guard_generation_status is '生成状态机单向转移守卫：终态不可再变更。';

create trigger generations_guard_status
  before update on public.generations
  for each row execute function public.guard_generation_status();

-- ----------------------------------------------------------------------------
-- RLS 复用：判定某项目是否归当前认证用户所有
-- security definer 以便在策略中跨表读取 projects 而不受其自身 RLS 影响。
-- ----------------------------------------------------------------------------
create or replace function private.is_project_owner(p_project_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
      from public.projects p
     where p.id = p_project_id
       and p.owner_id = auth.uid()
  );
$$;

comment on function private.is_project_owner is '判定 p_project_id 是否归当前认证用户所有，供从属表 RLS 复用。';

-- ----------------------------------------------------------------------------
-- RLS 复用：经会话判定某消息所属项目是否归当前用户
-- ----------------------------------------------------------------------------
create or replace function private.owns_conversation(p_conversation_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
      from public.conversations c
      join public.projects p on p.id = c.project_id
     where c.id = p_conversation_id
       and p.owner_id = auth.uid()
  );
$$;

comment on function private.owns_conversation is '判定会话所属项目是否归当前用户，供 messages RLS 复用。';
