-- ============================================================================
-- 迁移 0003：数据表
--
-- 按第 03 篇第三节逐表建立。所有表具备 id（UUID 主键）与 created_at；可变表另具
-- updated_at（由触发器维护，见迁移 0005）。部分外键构成环（节点↔生成↔资产），
-- 故先建表、后以 ALTER 追加这些环上的外键。
-- ============================================================================

-- ----------------------------------------------------------------------------
-- profiles（用户档案）：与 auth.users 一一对应，注册时由触发器自动建行。
-- ----------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  avatar_url text,
  locale text not null default 'zh-CN',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is '用户业务档案，1:1 对应 auth.users。';

-- ----------------------------------------------------------------------------
-- projects（项目）：一块画布及其会话的容器，对应主页「最近项目」卡片。
-- ----------------------------------------------------------------------------
create table public.projects (
  id uuid primary key default gen_random_uuid (),
  owner_id uuid not null references public.profiles (id) on delete cascade,
  title text not null default 'Untitled',
  thumbnail_url text,
  viewport jsonb not null default '{"x": 0, "y": 0, "zoom": 1}'::jsonb,
  initial_scene text check (
    initial_scene is null
    or initial_scene in ('design', 'branding', 'ecommerce', 'video')
  ),
  default_model_key text,
  is_deleted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_opened_at timestamptz
);

comment on table public.projects is '项目：画布 + 会话的容器；删除以 is_deleted 软删表达。';

-- ----------------------------------------------------------------------------
-- conversations（会话）：项目内用户与智能体的连续对话。
-- ----------------------------------------------------------------------------
create table public.conversations (
  id uuid primary key default gen_random_uuid (),
  project_id uuid not null references public.projects (id) on delete cascade,
  title text not null default '新对话',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.conversations is '会话：一个项目通常一条主会话，允许多条。';

-- ----------------------------------------------------------------------------
-- messages（消息）：会话中的一条发言。mentions / attachments 为 JSONB 数组。
-- ----------------------------------------------------------------------------
create table public.messages (
  id uuid primary key default gen_random_uuid (),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  role public.message_role not null,
  content text,
  model_key text,
  agent_mode text,
  mentions jsonb not null default '[]'::jsonb,
  attachments jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

comment on table public.messages is '消息：mentions 为被 @ 提及的节点引用，attachments 为附件资产引用。';

-- ----------------------------------------------------------------------------
-- canvas_nodes（画布节点）：一节点一行，无限画布数据的核心。
-- data 为类型私有内容（判别联合，随 type 而变）。
-- ----------------------------------------------------------------------------
create table public.canvas_nodes (
  id uuid primary key default gen_random_uuid (),
  project_id uuid not null references public.projects (id) on delete cascade,
  type public.node_type not null,
  position_x double precision not null,
  position_y double precision not null,
  width double precision,
  height double precision,
  rotation double precision not null default 0,
  z_index integer not null default 0,
  parent_id uuid references public.canvas_nodes (id) on delete set null,
  data jsonb not null default '{}'::jsonb,
  asset_id uuid, -- FK 见迁移末尾（环）
  generation_id uuid, -- FK 见迁移末尾（环）
  created_by uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.canvas_nodes is '画布节点：行 id 即 React Flow 节点 id；位置以 flow 逻辑坐标存储。';

-- ----------------------------------------------------------------------------
-- canvas_edges（画布边）：记录可选连接（主要为生成血缘）。
-- ----------------------------------------------------------------------------
create table public.canvas_edges (
  id uuid primary key default gen_random_uuid (),
  project_id uuid not null references public.projects (id) on delete cascade,
  source_node_id uuid not null references public.canvas_nodes (id) on delete cascade,
  target_node_id uuid not null references public.canvas_nodes (id) on delete cascade,
  source_handle text,
  target_handle text,
  type text not null default 'default',
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

comment on table public.canvas_edges is '画布边：次要构件，主要用于记录生成血缘。';

-- ----------------------------------------------------------------------------
-- generations（生成任务）：AI 流水线的状态载体。
-- ----------------------------------------------------------------------------
create table public.generations (
  id uuid primary key default gen_random_uuid (),
  project_id uuid not null references public.projects (id) on delete cascade,
  conversation_id uuid references public.conversations (id) on delete set null,
  message_id uuid references public.messages (id) on delete set null,
  modality public.modality not null,
  model_key text not null,
  provider text not null,
  prompt text,
  params jsonb not null default '{}'::jsonb,
  status public.generation_status not null default 'pending',
  progress integer not null default 0 check (progress between 0 and 100),
  external_job_id text,
  result_asset_id uuid, -- FK 见迁移末尾（环）
  placeholder_node_id uuid, -- FK 见迁移末尾（环）
  error text,
  idempotency_key text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

comment on table public.generations is '生成任务：一次调用外部模型产出内容的异步作业。';

-- ----------------------------------------------------------------------------
-- assets（资产）：Storage 中一份媒体文件的数据库记录。
-- ----------------------------------------------------------------------------
create table public.assets (
  id uuid primary key default gen_random_uuid (),
  owner_id uuid not null references public.profiles (id) on delete cascade,
  project_id uuid references public.projects (id) on delete set null,
  kind public.asset_kind not null,
  source public.asset_source not null,
  generation_id uuid, -- FK 见迁移末尾（环）
  storage_bucket text not null,
  storage_path text not null,
  mime_type text not null,
  width integer,
  height integer,
  duration_ms integer,
  size_bytes bigint,
  thumbnail_path text,
  created_at timestamptz not null default now()
);

comment on table public.assets is '资产：上传或生成而来的媒体文件记录，路径以用户 id 为顶层前缀。';

-- ----------------------------------------------------------------------------
-- model_catalog（模型目录）：驱动选择条与参数 UI 的可配置清单，一行一模型。
-- ----------------------------------------------------------------------------
create table public.model_catalog (
  id uuid primary key default gen_random_uuid (),
  key text not null unique,
  display_name text not null,
  provider text not null,
  modality public.modality not null,
  capabilities jsonb not null default '{}'::jsonb,
  default_params jsonb not null default '{}'::jsonb,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

comment on table public.model_catalog is '模型目录：数据驱动 UI，新增模型只追加一行。';

-- ----------------------------------------------------------------------------
-- 环上外键：节点 ↔ 生成 ↔ 资产
-- ----------------------------------------------------------------------------
alter table public.canvas_nodes
  add constraint canvas_nodes_asset_id_fkey
    foreign key (asset_id) references public.assets (id) on delete set null,
  add constraint canvas_nodes_generation_id_fkey
    foreign key (generation_id) references public.generations (id) on delete set null;

alter table public.generations
  add constraint generations_result_asset_id_fkey
    foreign key (result_asset_id) references public.assets (id) on delete set null,
  add constraint generations_placeholder_node_id_fkey
    foreign key (placeholder_node_id) references public.canvas_nodes (id) on delete set null;

alter table public.assets
  add constraint assets_generation_id_fkey
    foreign key (generation_id) references public.generations (id) on delete set null;
