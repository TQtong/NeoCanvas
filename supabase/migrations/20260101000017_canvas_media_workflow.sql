-- ============================================================================
-- 0017: 画布内媒体对话、候选历史与候选替换
-- ============================================================================

alter type public.node_type add value if not exists 'media_panel';

alter table public.conversations
  add column if not exists target_node_id uuid references public.canvas_nodes (id) on delete set null;

comment on column public.conversations.target_node_id is
  '媒体节点级会话归属；为空表示历史项目级会话。';

create unique index if not exists conversations_project_target_node_key
  on public.conversations (project_id, target_node_id)
  where target_node_id is not null;

alter table public.generations
  add column if not exists target_node_id uuid references public.canvas_nodes (id) on delete set null,
  add column if not exists result_mode text not null default 'new_primary'
    check (result_mode in ('new_primary', 'candidate_for_target'));

comment on column public.generations.target_node_id is
  '结果归属的主媒体节点；候选生成时用于把产出落到目标媒体旁边。';
comment on column public.generations.result_mode is
  '结果落图语义：new_primary 表示新主媒体，candidate_for_target 表示目标媒体候选。';

create index if not exists generations_target_node_idx
  on public.generations (target_node_id)
  where target_node_id is not null;

create index if not exists canvas_nodes_candidate_of_idx
  on public.canvas_nodes ((data ->> 'candidateOf'))
  where data ? 'candidateOf';

create or replace function public.swap_media_candidate(
  p_project_id uuid,
  p_primary_node_id uuid,
  p_candidate_node_id uuid
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_primary public.canvas_nodes%rowtype;
  v_candidate public.canvas_nodes%rowtype;
  v_candidate_index integer;
  v_primary_data jsonb;
  v_candidate_data jsonb;
begin
  select * into v_primary
    from public.canvas_nodes
   where id = p_primary_node_id
     and project_id = p_project_id
     and type in ('image', 'video')
   for update;

  if not found then
    raise exception 'primary media node not found';
  end if;

  select * into v_candidate
    from public.canvas_nodes
   where id = p_candidate_node_id
     and project_id = p_project_id
     and type in ('image', 'video')
   for update;

  if not found then
    raise exception 'candidate media node not found';
  end if;

  if coalesce(v_candidate.data ->> 'candidateOf', '') <> p_primary_node_id::text then
    raise exception 'candidate does not belong to primary node';
  end if;

  v_candidate_index := nullif(v_candidate.data ->> 'candidateIndex', '')::integer;

  v_candidate_data :=
    (coalesce(v_candidate.data, '{}'::jsonb) - 'candidateOf' - 'candidateIndex')
    || jsonb_build_object('mediaRole', 'primary');

  v_primary_data :=
    (coalesce(v_primary.data, '{}'::jsonb) - 'candidateOf' - 'candidateIndex')
    || jsonb_build_object(
      'mediaRole', 'candidate',
      'candidateOf', p_primary_node_id::text,
      'candidateIndex', v_candidate_index
    );

  update public.canvas_nodes
     set type = v_candidate.type,
         asset_id = v_candidate.asset_id,
         generation_id = v_candidate.generation_id,
         data = v_candidate_data
   where id = p_primary_node_id;

  update public.canvas_nodes
     set type = v_primary.type,
         asset_id = v_primary.asset_id,
         generation_id = v_primary.generation_id,
         data = v_primary_data
   where id = p_candidate_node_id;

  return true;
end;
$$;

comment on function public.swap_media_candidate is
  '原子替换主媒体与候选媒体：主节点 id 保持不变，旧主媒体留在候选节点中。';

revoke all on function public.swap_media_candidate(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.swap_media_candidate(uuid, uuid, uuid) to service_role;
