-- ============================================================================
-- 迁移 0034：Flow Studio 数据模型、RLS、Realtime 与图修订触发器
-- ============================================================================

create type public.flow_value_type as enum (
  'text', 'number', 'boolean', 'image_asset', 'video_asset', 'mask_asset',
  'image_list', 'keyframe_list'
);

create type public.workflow_node_kind as enum (
  'text_input', 'image_input', 'video_input', 'mask_input', 'prompt_template',
  'image_collection', 'keyframe_collection', 'image_select', 'image_generate',
  'image_semantic_edit', 'image_inpaint', 'image_outpaint',
  'image_remove_background', 'image_upscale', 'video_generate', 'sequence_video',
  'text_output', 'image_output', 'video_output', 'gallery_output', 'note'
);

create type public.workflow_run_status as enum (
  'queued', 'running', 'waiting_user', 'succeeded', 'partial', 'failed', 'cancelled'
);

create type public.workflow_run_node_status as enum (
  'pending', 'cached', 'queued', 'running', 'waiting_generation', 'waiting_user',
  'succeeded', 'failed', 'skipped', 'cancelled'
);

create table public.workflows (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  description text check (description is null or char_length(description) <= 2000),
  graph_revision bigint not null default 0 check (graph_revision >= 0),
  viewport jsonb not null default '{"x":0,"y":0,"zoom":1}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, project_id),
  unique (id, owner_id)
);

create table public.workflow_nodes (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.workflows(id) on delete cascade,
  kind public.workflow_node_kind not null,
  position_x double precision not null,
  position_y double precision not null,
  config jsonb not null default '{}'::jsonb check (jsonb_typeof(config) = 'object'),
  schema_version integer not null default 1 check (schema_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, workflow_id)
);

create table public.workflow_edges (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.workflows(id) on delete cascade,
  source_node_id uuid not null,
  source_port text not null check (char_length(source_port) between 1 and 80),
  target_node_id uuid not null,
  target_port text not null check (char_length(target_port) between 1 and 80),
  value_type public.flow_value_type not null,
  created_at timestamptz not null default now(),
  foreign key (source_node_id, workflow_id)
    references public.workflow_nodes(id, workflow_id) on delete cascade,
  foreign key (target_node_id, workflow_id)
    references public.workflow_nodes(id, workflow_id) on delete cascade,
  check (source_node_id <> target_node_id),
  unique (workflow_id, target_node_id, target_port, source_node_id, source_port)
);

create table public.workflow_revisions (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.workflows(id) on delete cascade,
  revision_no bigint not null check (revision_no >= 0),
  graph_hash text not null check (char_length(graph_hash) between 16 and 128),
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (workflow_id, revision_no)
);

create table public.workflow_revision_nodes (
  revision_id uuid not null references public.workflow_revisions(id) on delete cascade,
  node_id uuid not null,
  kind public.workflow_node_kind not null,
  position_x double precision not null,
  position_y double precision not null,
  config jsonb not null check (jsonb_typeof(config) = 'object'),
  schema_version integer not null check (schema_version > 0),
  primary key (revision_id, node_id)
);

create table public.workflow_revision_edges (
  revision_id uuid not null references public.workflow_revisions(id) on delete cascade,
  edge_id uuid not null,
  source_node_id uuid not null,
  source_port text not null,
  target_node_id uuid not null,
  target_port text not null,
  value_type public.flow_value_type not null,
  primary key (revision_id, edge_id),
  foreign key (revision_id, source_node_id)
    references public.workflow_revision_nodes(revision_id, node_id) on delete cascade,
  foreign key (revision_id, target_node_id)
    references public.workflow_revision_nodes(revision_id, node_id) on delete cascade
);

create table public.workflow_revision_asset_refs (
  revision_id uuid not null references public.workflow_revisions(id) on delete cascade,
  node_id uuid not null,
  asset_id uuid not null references public.assets(id) on delete restrict,
  role text not null default 'input',
  ordinal integer not null default 0 check (ordinal >= 0),
  primary key (revision_id, node_id, asset_id, role, ordinal),
  foreign key (revision_id, node_id)
    references public.workflow_revision_nodes(revision_id, node_id) on delete cascade
);

create table public.workflow_runs (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.workflows(id) on delete cascade,
  revision_id uuid not null references public.workflow_revisions(id) on delete restrict,
  project_id uuid not null references public.projects(id) on delete cascade,
  requester_id uuid not null references public.profiles(id) on delete cascade,
  status public.workflow_run_status not null default 'queued',
  run_mode text not null check (run_mode in ('node', 'downstream', 'all')),
  target_node_id uuid,
  force_rerun boolean not null default false,
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 200),
  request_hash text not null check (char_length(request_hash) between 16 and 128),
  error text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  unique (requester_id, workflow_id, idempotency_key)
);

create table public.workflow_run_nodes (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.workflow_runs(id) on delete cascade,
  workflow_node_id uuid not null,
  kind public.workflow_node_kind not null,
  status public.workflow_run_node_status not null default 'pending',
  config_snapshot jsonb not null check (jsonb_typeof(config_snapshot) = 'object'),
  cache_key text,
  cache_source_run_node_id uuid references public.workflow_run_nodes(id) on delete set null,
  model_key text,
  provider text,
  resolved_provider_model text,
  executor_version text not null default '1',
  runtime_input jsonb not null default '{}'::jsonb check (jsonb_typeof(runtime_input) = 'object'),
  error text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (run_id, workflow_node_id)
);

create table public.workflow_run_outputs (
  id uuid primary key default gen_random_uuid(),
  run_node_id uuid not null references public.workflow_run_nodes(id) on delete cascade,
  port_id text not null check (char_length(port_id) between 1 and 80),
  value_type public.flow_value_type not null,
  asset_id uuid references public.assets(id) on delete restrict,
  value jsonb,
  ordinal integer not null default 0 check (ordinal >= 0),
  canvas_node_id uuid references public.canvas_nodes(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (run_node_id, port_id, ordinal)
);

create table public.workflow_run_input_links (
  run_id uuid not null references public.workflow_runs(id) on delete cascade,
  source_run_node_id uuid not null references public.workflow_run_nodes(id) on delete cascade,
  source_port text not null,
  target_run_node_id uuid not null references public.workflow_run_nodes(id) on delete cascade,
  target_port text not null,
  ordinal integer not null default 0 check (ordinal >= 0),
  primary key (run_id, target_run_node_id, target_port, ordinal)
);

create table public.workflow_templates (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  description text check (description is null or char_length(description) <= 2000),
  latest_version integer not null default 0 check (latest_version >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.workflow_template_versions (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.workflow_templates(id) on delete cascade,
  version integer not null check (version > 0),
  graph jsonb not null check (jsonb_typeof(graph) = 'object'),
  created_at timestamptz not null default now(),
  unique (template_id, version)
);

create table public.flow_apps (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  description text check (description is null or char_length(description) <= 2000),
  latest_version integer not null default 0 check (latest_version >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.flow_app_versions (
  id uuid primary key default gen_random_uuid(),
  flow_app_id uuid not null references public.flow_apps(id) on delete cascade,
  version integer not null check (version > 0),
  template_version_id uuid not null references public.workflow_template_versions(id) on delete restrict,
  fields jsonb not null default '[]'::jsonb check (jsonb_typeof(fields) = 'array'),
  outputs jsonb not null default '[]'::jsonb check (jsonb_typeof(outputs) = 'array'),
  created_at timestamptz not null default now(),
  unique (flow_app_id, version)
);

create table public.workflow_patch_proposals (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.workflows(id) on delete cascade,
  requested_by uuid not null references public.profiles(id) on delete cascade,
  base_graph_revision bigint not null check (base_graph_revision >= 0),
  instruction text not null check (char_length(btrim(instruction)) between 1 and 10000),
  operations jsonb not null default '[]'::jsonb check (jsonb_typeof(operations) = 'array'),
  status text not null default 'pending' check (status in ('pending', 'applied', 'rejected', 'expired')),
  expires_at timestamptz not null default (now() + interval '30 minutes'),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

alter table public.generations
  add column workflow_run_node_id uuid references public.workflow_run_nodes(id) on delete set null;

alter table public.generations drop constraint if exists generations_result_mode_check;
alter table public.generations add constraint generations_result_mode_check
  check (result_mode in ('new_primary', 'candidate_for_target', 'workflow_output'));
alter table public.generations add constraint generations_workflow_output_shape_check check (
  (result_mode = 'workflow_output' and workflow_run_node_id is not null and placeholder_node_id is null)
  or (result_mode <> 'workflow_output' and workflow_run_node_id is null)
);

create index workflow_nodes_workflow_idx on public.workflow_nodes(workflow_id);
create index workflow_edges_source_idx on public.workflow_edges(workflow_id, source_node_id);
create index workflow_edges_target_idx on public.workflow_edges(workflow_id, target_node_id);
create index workflow_runs_history_idx on public.workflow_runs(workflow_id, created_at desc);
create index workflow_run_nodes_status_idx on public.workflow_run_nodes(run_id, status);
create index workflow_run_nodes_cache_idx on public.workflow_run_nodes(cache_key, completed_at desc)
  where status in ('succeeded', 'cached');
create index workflow_run_outputs_node_idx on public.workflow_run_outputs(run_node_id, port_id, ordinal);
create index workflow_patch_pending_idx on public.workflow_patch_proposals(workflow_id, created_at desc)
  where status = 'pending';
create index generations_workflow_run_node_idx on public.generations(workflow_run_node_id)
  where workflow_run_node_id is not null;

create trigger workflows_set_updated_at before update on public.workflows
  for each row execute function public.handle_updated_at();
create trigger workflow_nodes_set_updated_at before update on public.workflow_nodes
  for each row execute function public.handle_updated_at();
create trigger workflow_templates_set_updated_at before update on public.workflow_templates
  for each row execute function public.handle_updated_at();
create trigger flow_apps_set_updated_at before update on public.flow_apps
  for each row execute function public.handle_updated_at();

create or replace function public.bump_workflow_graph_revision()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_workflow_id uuid;
begin
  v_workflow_id := case when tg_op = 'DELETE' then old.workflow_id else new.workflow_id end;
  update public.workflows
     set graph_revision = graph_revision + 1
   where id = v_workflow_id;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create trigger workflow_nodes_bump_revision after insert or update or delete on public.workflow_nodes
  for each row execute function public.bump_workflow_graph_revision();
create trigger workflow_edges_bump_revision after insert or update or delete on public.workflow_edges
  for each row execute function public.bump_workflow_graph_revision();

create or replace function private.is_workflow_owner(p_workflow_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.workflows w
     where w.id = p_workflow_id and w.owner_id = auth.uid()
  );
$$;

create or replace function private.owns_workflow_run(p_run_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.workflow_runs r
     where r.id = p_run_id and r.requester_id = auth.uid()
  );
$$;

alter table public.workflows enable row level security;
alter table public.workflow_nodes enable row level security;
alter table public.workflow_edges enable row level security;
alter table public.workflow_revisions enable row level security;
alter table public.workflow_revision_nodes enable row level security;
alter table public.workflow_revision_edges enable row level security;
alter table public.workflow_revision_asset_refs enable row level security;
alter table public.workflow_runs enable row level security;
alter table public.workflow_run_nodes enable row level security;
alter table public.workflow_run_outputs enable row level security;
alter table public.workflow_run_input_links enable row level security;
alter table public.workflow_templates enable row level security;
alter table public.workflow_template_versions enable row level security;
alter table public.flow_apps enable row level security;
alter table public.flow_app_versions enable row level security;
alter table public.workflow_patch_proposals enable row level security;

create policy workflows_select on public.workflows for select using (owner_id = auth.uid());
create policy workflows_insert on public.workflows for insert with check (
  owner_id = auth.uid() and private.is_project_owner(project_id)
);
create policy workflows_update on public.workflows for update using (owner_id = auth.uid())
  with check (owner_id = auth.uid() and private.is_project_owner(project_id));
create policy workflows_delete on public.workflows for delete using (owner_id = auth.uid());

create policy workflow_nodes_select on public.workflow_nodes for select
  using (private.is_workflow_owner(workflow_id));
create policy workflow_nodes_insert on public.workflow_nodes for insert
  with check (private.is_workflow_owner(workflow_id));
create policy workflow_nodes_update on public.workflow_nodes for update
  using (private.is_workflow_owner(workflow_id)) with check (private.is_workflow_owner(workflow_id));
create policy workflow_nodes_delete on public.workflow_nodes for delete
  using (private.is_workflow_owner(workflow_id));

create policy workflow_edges_select on public.workflow_edges for select
  using (private.is_workflow_owner(workflow_id));
create policy workflow_edges_insert on public.workflow_edges for insert
  with check (private.is_workflow_owner(workflow_id));
create policy workflow_edges_update on public.workflow_edges for update
  using (private.is_workflow_owner(workflow_id)) with check (private.is_workflow_owner(workflow_id));
create policy workflow_edges_delete on public.workflow_edges for delete
  using (private.is_workflow_owner(workflow_id));

create policy workflow_revisions_select on public.workflow_revisions for select
  using (private.is_workflow_owner(workflow_id));
create policy workflow_revision_nodes_select on public.workflow_revision_nodes for select using (
  exists (select 1 from public.workflow_revisions r where r.id = revision_id
    and private.is_workflow_owner(r.workflow_id))
);
create policy workflow_revision_edges_select on public.workflow_revision_edges for select using (
  exists (select 1 from public.workflow_revisions r where r.id = revision_id
    and private.is_workflow_owner(r.workflow_id))
);
create policy workflow_revision_asset_refs_select on public.workflow_revision_asset_refs for select using (
  exists (select 1 from public.workflow_revisions r where r.id = revision_id
    and private.is_workflow_owner(r.workflow_id))
);

create policy workflow_runs_select on public.workflow_runs for select
  using (requester_id = auth.uid());
create policy workflow_run_nodes_select on public.workflow_run_nodes for select
  using (private.owns_workflow_run(run_id));
create policy workflow_run_outputs_select on public.workflow_run_outputs for select using (
  exists (select 1 from public.workflow_run_nodes n where n.id = run_node_id
    and private.owns_workflow_run(n.run_id))
);
create policy workflow_run_input_links_select on public.workflow_run_input_links for select
  using (private.owns_workflow_run(run_id));

create policy workflow_templates_select on public.workflow_templates for select
  using (owner_id = auth.uid());
create policy workflow_template_versions_select on public.workflow_template_versions for select using (
  exists (select 1 from public.workflow_templates t where t.id = template_id
    and t.owner_id = auth.uid())
);
create policy flow_apps_select on public.flow_apps for select using (owner_id = auth.uid());
create policy flow_app_versions_select on public.flow_app_versions for select using (
  exists (select 1 from public.flow_apps a where a.id = flow_app_id and a.owner_id = auth.uid())
);
create policy workflow_patch_proposals_select on public.workflow_patch_proposals for select
  using (requested_by = auth.uid());

grant select, insert, update, delete on public.workflows, public.workflow_nodes,
  public.workflow_edges to authenticated;
grant select on public.workflow_revisions, public.workflow_revision_nodes,
  public.workflow_revision_edges, public.workflow_revision_asset_refs, public.workflow_runs,
  public.workflow_run_nodes, public.workflow_run_outputs, public.workflow_run_input_links,
  public.workflow_templates, public.workflow_template_versions, public.flow_apps,
  public.flow_app_versions, public.workflow_patch_proposals to authenticated;
grant all on public.workflows, public.workflow_nodes, public.workflow_edges,
  public.workflow_revisions, public.workflow_revision_nodes, public.workflow_revision_edges,
  public.workflow_revision_asset_refs, public.workflow_runs, public.workflow_run_nodes,
  public.workflow_run_outputs, public.workflow_run_input_links, public.workflow_templates,
  public.workflow_template_versions, public.flow_apps, public.flow_app_versions,
  public.workflow_patch_proposals to service_role;

alter table public.workflows replica identity full;
alter table public.workflow_nodes replica identity full;
alter table public.workflow_edges replica identity full;
alter table public.workflow_runs replica identity full;
alter table public.workflow_run_nodes replica identity full;
alter table public.workflow_run_outputs replica identity full;

do $$
declare
  v_table text;
  v_tables text[] := array[
    'workflows', 'workflow_nodes', 'workflow_edges', 'workflow_runs',
    'workflow_run_nodes', 'workflow_run_outputs'
  ];
begin
  foreach v_table in array v_tables loop
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = v_table
    ) then
      execute format('alter publication supabase_realtime add table public.%I', v_table);
    end if;
  end loop;
end
$$;

comment on table public.workflows is 'Flow Studio 项目内可编辑工作流。';
comment on table public.workflow_revisions is '运行固定的不可变工作流图快照。';
comment on table public.workflow_runs is '一次显式工作流执行的状态与幂等账本。';
comment on column public.generations.workflow_run_node_id is
  'Flow 生成所属运行节点；workflow_output 不创建 Canvas 占位节点。';
