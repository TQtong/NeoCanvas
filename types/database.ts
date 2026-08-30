/**
 * 数据库行类型契约。
 *
 * 每个接口对应第 03 篇定义的一张表的一行，字段名与列名逐字一致（snake_case），
 * 供 PostgREST 数据层与映射器使用。JSONB 列以本目录其余模块定义的结构化类型约束，
 * 而非裸 `unknown`，从而前后端共享同一套结构理解。
 *
 * @module types/database
 */

import type {
  AssetKind,
  AssetSource,
  BuiltInProvider,
  GenerationStatus,
  MessageRole,
  Modality,
  NodeType,
  Provider,
  Scene,
} from './enums';
import type { EdgeData } from './edges';
import type { MessageAttachment, MessageMention } from './messages';
import type { ModelCapabilities, ModelDefaultParams } from './models';
import type { GenerationParams, ReferenceMaterial } from './generation';
import type { ProviderCredentialRow } from './providers';
import type {
  FlowAppFieldBinding,
  FlowAppOutputBinding,
  FlowValueType,
  WorkflowGraphEdge,
  WorkflowGraphNode,
  WorkflowNodeConfig,
  WorkflowNodeKind,
  WorkflowPatchOperation,
  WorkflowRunNodeStatus,
  WorkflowRunStatus,
} from './workflow';

/**
 * 画布视口：平移量与缩放比。持久化于 `projects.viewport`。
 */
export interface Viewport {
  /** 平移 X（屏幕像素偏移）。 */
  x: number;
  /** 平移 Y（屏幕像素偏移）。 */
  y: number;
  /** 缩放比。 */
  zoom: number;
}

/** `profiles` 表行。 */
export type ProfileRow = {
  id: string;
  display_name: string | null;
  avatar_url: string | null;
  locale: string;
  created_at: string;
  updated_at: string;
};

/** `projects` 表行。 */
export type ProjectRow = {
  id: string;
  owner_id: string;
  title: string;
  thumbnail_url: string | null;
  viewport: Viewport;
  initial_scene: Scene | null;
  default_model_key: string | null;
  is_deleted: boolean;
  /** 客户端请求标识：连点去重用，重复请求复用既有项目。 */
  client_request_id: string | null;
  created_at: string;
  updated_at: string;
  last_opened_at: string | null;
};

/**
 * `canvas_nodes` 表行。`data` 为类型私有内容（JSONB），与 `type` 配合还原为
 * {@link NodeData}（见 lib/canvas/node-mapper）。
 */
export type CanvasNodeRow = {
  id: string;
  project_id: string;
  type: NodeType;
  position_x: number;
  position_y: number;
  width: number | null;
  height: number | null;
  rotation: number;
  z_index: number;
  parent_id: string | null;
  /** 类型私有内容。结构随 type 而变，由映射器与 {@link NodeData} 对齐。 */
  data: Record<string, unknown>;
  asset_id: string | null;
  generation_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
};

/** `canvas_edges` 表行。 */
export type CanvasEdgeRow = {
  id: string;
  project_id: string;
  source_node_id: string;
  target_node_id: string;
  source_handle: string | null;
  target_handle: string | null;
  type: string;
  data: EdgeData;
  created_at: string;
};

/** `conversations` 表行。 */
export type ConversationRow = {
  id: string;
  project_id: string;
  title: string;
  target_node_id: string | null;
  created_at: string;
  updated_at: string;
};

/** `messages` 表行。 */
export type MessageRow = {
  id: string;
  conversation_id: string;
  role: MessageRole;
  content: string | null;
  model_key: string | null;
  agent_mode: string | null;
  /** 助手消息所回应的用户消息 id；用于编排幂等。用户消息为空。 */
  user_message_id: string | null;
  mentions: MessageMention[];
  attachments: MessageAttachment[];
  created_at: string;
};

/** `generations` 表行。 */
export type GenerationRow = {
  id: string;
  project_id: string;
  conversation_id: string | null;
  message_id: string | null;
  modality: Modality;
  model_key: string;
  provider: Provider;
  prompt: string | null;
  params: GenerationParams;
  status: GenerationStatus;
  progress: number;
  external_job_id: string | null;
  result_asset_id: string | null;
  placeholder_node_id: string | null;
  target_node_id: string | null;
  result_mode: 'new_primary' | 'candidate_for_target' | 'workflow_output';
  /** Flow 生成所属运行节点；普通 Canvas 生成为空。 */
  workflow_run_node_id: string | null;
  error: string | null;
  idempotency_key: string | null;
  /** 发起生成的业务用户；用于服务角色路径显式归属校验。 */
  requester_id: string;
  /** 幂等操作域，当前生成请求固定为 generation。 */
  operation_type: string;
  /** 规范化请求的 SHA-256。 */
  request_hash: string | null;
  /** 原子提交写入 pgmq 后返回的消息 id。 */
  submission_queue_message_id: number | null;
  /** Provider 产出元数据摘要，不含临时地址和凭据。 */
  provider_output_summary: Record<string, unknown> | null;
  /** 每任务 webhook secret 的 SHA-256；不保存明文。 */
  webhook_secret_hash: string | null;
  webhook_secret_expires_at: string | null;
  /** poller 的短租约，防多个批次同时查询同一任务。 */
  poll_lease_token: string | null;
  poll_lease_until: string | null;
  /** 内容安全审核状态：pending / passed / blocked。 */
  moderation_status: string;
  /** 审核拦截原因（命中策略或产出被过滤），无则为空。 */
  moderation_reason: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

/** `workflows` 表行。 */
export type WorkflowRow = {
  id: string;
  project_id: string;
  owner_id: string;
  name: string;
  description: string | null;
  graph_revision: number;
  viewport: Viewport;
  created_at: string;
  updated_at: string;
};

/** `workflow_nodes` 表行。 */
export type WorkflowNodeRow = {
  id: string;
  workflow_id: string;
  kind: WorkflowNodeKind;
  position_x: number;
  position_y: number;
  config: WorkflowNodeConfig;
  schema_version: number;
  created_at: string;
  updated_at: string;
};

/** `workflow_edges` 表行。 */
export type WorkflowEdgeRow = {
  id: string;
  workflow_id: string;
  source_node_id: string;
  source_port: string;
  target_node_id: string;
  target_port: string;
  value_type: FlowValueType;
  created_at: string;
};

/** `workflow_revisions` 表行。 */
export type WorkflowRevisionRow = {
  id: string;
  workflow_id: string;
  revision_no: number;
  graph_hash: string;
  created_by: string;
  created_at: string;
};

/** `workflow_runs` 表行。 */
export type WorkflowRunRow = {
  id: string;
  workflow_id: string;
  revision_id: string;
  project_id: string;
  requester_id: string;
  status: WorkflowRunStatus;
  run_mode: 'node' | 'downstream' | 'all';
  target_node_id: string | null;
  force_rerun: boolean;
  idempotency_key: string;
  request_hash: string;
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
};

/** `workflow_run_nodes` 表行。 */
export type WorkflowRunNodeRow = {
  id: string;
  run_id: string;
  workflow_node_id: string;
  kind: WorkflowNodeKind;
  status: WorkflowRunNodeStatus;
  config_snapshot: WorkflowNodeConfig;
  cache_key: string | null;
  cache_source_run_node_id: string | null;
  model_key: string | null;
  provider: string | null;
  resolved_provider_model: string | null;
  executor_version: string;
  runtime_input: Record<string, unknown>;
  error: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
};

/** `workflow_run_outputs` 表行。 */
export type WorkflowRunOutputRow = {
  id: string;
  run_node_id: string;
  port_id: string;
  value_type: FlowValueType;
  asset_id: string | null;
  value: string | number | boolean | string[] | null;
  ordinal: number;
  canvas_node_id: string | null;
  created_at: string;
};

/** `workflow_templates` 表行。 */
export type WorkflowTemplateRow = {
  id: string;
  owner_id: string;
  name: string;
  description: string | null;
  latest_version: number;
  created_at: string;
  updated_at: string;
};

/** `workflow_template_versions` 表行。 */
export type WorkflowTemplateVersionRow = {
  id: string;
  template_id: string;
  version: number;
  graph: { nodes: WorkflowGraphNode[]; edges: WorkflowGraphEdge[] };
  created_at: string;
};

/** `flow_apps` 表行。 */
export type FlowAppRow = {
  id: string;
  owner_id: string;
  project_id: string;
  name: string;
  description: string | null;
  latest_version: number;
  created_at: string;
  updated_at: string;
};

/** `flow_app_versions` 表行。 */
export type FlowAppVersionRow = {
  id: string;
  flow_app_id: string;
  version: number;
  template_version_id: string;
  fields: FlowAppFieldBinding[];
  outputs: FlowAppOutputBinding[];
  created_at: string;
};

/** `workflow_patch_proposals` 表行。 */
export type WorkflowPatchProposalRow = {
  id: string;
  workflow_id: string;
  requested_by: string;
  base_graph_revision: number;
  instruction: string;
  operations: WorkflowPatchOperation[];
  status: 'pending' | 'applied' | 'rejected' | 'expired';
  expires_at: string;
  created_at: string;
  resolved_at: string | null;
};

/** `generation_output_attempts` 暂存补偿账本。 */
export type GenerationOutputAttemptRow = {
  id: string;
  generation_id: string;
  owner_id: string;
  staging_prefix: string;
  storage_bucket: string;
  object_paths: string[];
  status: 'uploading' | 'staged' | 'committed' | 'discarded' | 'rpc_failed' | 'cleaned';
  cleanup_after: string;
  error: string | null;
  created_at: string;
  updated_at: string;
};

/** `generation_webhook_events` 回调重放门禁行。 */
export type GenerationWebhookEventRow = {
  id: string;
  generation_id: string;
  provider: Provider;
  event_key: string;
  received_at: string;
};

/** `assets` 表行。 */
export type AssetRow = {
  id: string;
  owner_id: string;
  project_id: string | null;
  kind: AssetKind;
  source: AssetSource;
  generation_id: string | null;
  storage_bucket: string;
  storage_path: string;
  mime_type: string;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  size_bytes: number | null;
  thumbnail_path: string | null;
  /** 是否为蒙版、合成输入或按模型限制生成的辅助资产。 */
  is_auxiliary: boolean;
  created_at: string;
};

/** `generation_inputs` 有序生成输入血缘行。 */
export type GenerationInputRow = {
  generation_id: string;
  asset_id: string;
  role: ReferenceMaterial['role'];
  ordinal: number;
  created_at: string;
};

/** `model_catalog` 表行。 */
export type ModelCatalogRow = {
  id: string;
  key: string;
  display_name: string;
  provider: Provider;
  modality: Modality;
  capabilities: ModelCapabilities;
  default_params: ModelDefaultParams;
  sort_order: number;
  is_active: boolean;
  /** 归属用户：null=内置种子（全局只读）；非空=该用户自有模型。 */
  user_id: string | null;
  created_at: string;
};

/**
 * Supabase 数据库的强类型描述，供 `createClient<Database>` 泛型使用，
 * 使 PostgREST 查询的返回与插入获得列级类型约束。
 */
export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: ProfileRow;
        Insert: Partial<Omit<ProfileRow, 'id'>> & { id: string };
        Update: Partial<ProfileRow>;
        Relationships: [];
      };
      projects: {
        Row: ProjectRow;
        Insert: Partial<Omit<ProjectRow, 'id' | 'created_at' | 'updated_at'>> & {
          owner_id: string;
        };
        Update: Partial<ProjectRow>;
        Relationships: [];
      };
      canvas_nodes: {
        Row: CanvasNodeRow;
        Insert: Partial<Omit<CanvasNodeRow, 'created_at' | 'updated_at'>> & {
          project_id: string;
          type: NodeType;
          position_x: number;
          position_y: number;
          created_by: string;
        };
        Update: Partial<CanvasNodeRow>;
        Relationships: [];
      };
      canvas_edges: {
        Row: CanvasEdgeRow;
        Insert: Partial<Omit<CanvasEdgeRow, 'created_at'>> & {
          project_id: string;
          source_node_id: string;
          target_node_id: string;
        };
        Update: Partial<CanvasEdgeRow>;
        Relationships: [];
      };
      conversations: {
        Row: ConversationRow;
        Insert: Partial<Omit<ConversationRow, 'created_at' | 'updated_at'>> & {
          project_id: string;
        };
        Update: Partial<ConversationRow>;
        Relationships: [];
      };
      messages: {
        Row: MessageRow;
        Insert: Partial<Omit<MessageRow, 'created_at'>> & {
          conversation_id: string;
          role: MessageRole;
        };
        Update: Partial<MessageRow>;
        Relationships: [];
      };
      generations: {
        Row: GenerationRow;
        Insert: Partial<Omit<GenerationRow, 'created_at' | 'updated_at'>> & {
          project_id: string;
          modality: Modality;
          model_key: string;
          provider: Provider;
        };
        Update: Partial<GenerationRow>;
        Relationships: [];
      };
      generation_output_attempts: {
        Row: GenerationOutputAttemptRow;
        Insert: Partial<Omit<GenerationOutputAttemptRow, 'created_at' | 'updated_at'>> & {
          id: string;
          generation_id: string;
          owner_id: string;
          staging_prefix: string;
        };
        Update: Partial<GenerationOutputAttemptRow>;
        Relationships: [];
      };
      generation_webhook_events: {
        Row: GenerationWebhookEventRow;
        Insert: Partial<Omit<GenerationWebhookEventRow, 'id' | 'received_at'>> & {
          generation_id: string;
          provider: Provider;
          event_key: string;
        };
        Update: Partial<GenerationWebhookEventRow>;
        Relationships: [];
      };
      generation_inputs: {
        Row: GenerationInputRow;
        Insert: Omit<GenerationInputRow, 'created_at'> & { created_at?: string };
        Update: Partial<GenerationInputRow>;
        Relationships: [];
      };
      assets: {
        Row: AssetRow;
        Insert: Partial<Omit<AssetRow, 'created_at'>> & {
          owner_id: string;
          kind: AssetKind;
          source: AssetSource;
          storage_bucket: string;
          storage_path: string;
          mime_type: string;
        };
        Update: Partial<AssetRow>;
        Relationships: [];
      };
      model_catalog: {
        Row: ModelCatalogRow;
        Insert: Partial<Omit<ModelCatalogRow, 'created_at'>> & {
          key: string;
          display_name: string;
          provider: Provider;
          modality: Modality;
        };
        Update: Partial<ModelCatalogRow>;
        Relationships: [];
      };
      provider_credentials: {
        Row: ProviderCredentialRow;
        Insert: Partial<Omit<ProviderCredentialRow, 'id' | 'created_at' | 'updated_at'>> & {
          user_id: string;
          provider: Provider;
          adapter: BuiltInProvider;
          key_last4: string;
          key_secret_id: string;
        };
        Update: Partial<ProviderCredentialRow>;
        Relationships: [];
      };
      workflows: {
        Row: WorkflowRow;
        Insert: Partial<Omit<WorkflowRow, 'id' | 'created_at' | 'updated_at'>> & {
          project_id: string;
          owner_id: string;
          name: string;
        };
        Update: Partial<WorkflowRow>;
        Relationships: [];
      };
      workflow_nodes: {
        Row: WorkflowNodeRow;
        Insert: Partial<Omit<WorkflowNodeRow, 'created_at' | 'updated_at'>> & {
          id: string;
          workflow_id: string;
          kind: WorkflowNodeKind;
          position_x: number;
          position_y: number;
          config: WorkflowNodeConfig;
        };
        Update: Partial<WorkflowNodeRow>;
        Relationships: [];
      };
      workflow_edges: {
        Row: WorkflowEdgeRow;
        Insert: Partial<Omit<WorkflowEdgeRow, 'created_at'>> & {
          id: string;
          workflow_id: string;
          source_node_id: string;
          source_port: string;
          target_node_id: string;
          target_port: string;
          value_type: FlowValueType;
        };
        Update: Partial<WorkflowEdgeRow>;
        Relationships: [];
      };
      workflow_revisions: {
        Row: WorkflowRevisionRow;
        Insert: Partial<Omit<WorkflowRevisionRow, 'id' | 'created_at'>> & {
          workflow_id: string;
          revision_no: number;
          graph_hash: string;
          created_by: string;
        };
        Update: Partial<WorkflowRevisionRow>;
        Relationships: [];
      };
      workflow_runs: {
        Row: WorkflowRunRow;
        Insert: Partial<Omit<WorkflowRunRow, 'id' | 'created_at'>> & {
          workflow_id: string;
          revision_id: string;
          project_id: string;
          requester_id: string;
          idempotency_key: string;
          request_hash: string;
        };
        Update: Partial<WorkflowRunRow>;
        Relationships: [];
      };
      workflow_run_nodes: {
        Row: WorkflowRunNodeRow;
        Insert: Partial<Omit<WorkflowRunNodeRow, 'id' | 'created_at'>> & {
          run_id: string;
          workflow_node_id: string;
          kind: WorkflowNodeKind;
          config_snapshot: WorkflowNodeConfig;
        };
        Update: Partial<WorkflowRunNodeRow>;
        Relationships: [];
      };
      workflow_run_outputs: {
        Row: WorkflowRunOutputRow;
        Insert: Partial<Omit<WorkflowRunOutputRow, 'id' | 'created_at'>> & {
          run_node_id: string;
          port_id: string;
          value_type: FlowValueType;
          ordinal: number;
        };
        Update: Partial<WorkflowRunOutputRow>;
        Relationships: [];
      };
      workflow_templates: {
        Row: WorkflowTemplateRow;
        Insert: Partial<Omit<WorkflowTemplateRow, 'id' | 'created_at' | 'updated_at'>> & {
          owner_id: string;
          name: string;
        };
        Update: Partial<WorkflowTemplateRow>;
        Relationships: [];
      };
      workflow_template_versions: {
        Row: WorkflowTemplateVersionRow;
        Insert: Partial<Omit<WorkflowTemplateVersionRow, 'id' | 'created_at'>> & {
          template_id: string;
          version: number;
          graph: { nodes: WorkflowGraphNode[]; edges: WorkflowGraphEdge[] };
        };
        Update: Partial<WorkflowTemplateVersionRow>;
        Relationships: [];
      };
      flow_apps: {
        Row: FlowAppRow;
        Insert: Partial<Omit<FlowAppRow, 'id' | 'created_at' | 'updated_at'>> & {
          owner_id: string;
          project_id: string;
          name: string;
        };
        Update: Partial<FlowAppRow>;
        Relationships: [];
      };
      flow_app_versions: {
        Row: FlowAppVersionRow;
        Insert: Partial<Omit<FlowAppVersionRow, 'id' | 'created_at'>> & {
          flow_app_id: string;
          version: number;
          template_version_id: string;
        };
        Update: Partial<FlowAppVersionRow>;
        Relationships: [];
      };
      workflow_patch_proposals: {
        Row: WorkflowPatchProposalRow;
        Insert: Partial<Omit<WorkflowPatchProposalRow, 'id' | 'created_at'>> & {
          workflow_id: string;
          requested_by: string;
          base_graph_revision: number;
          instruction: string;
        };
        Update: Partial<WorkflowPatchProposalRow>;
        Relationships: [];
      };
    };
    Views: Record<never, never>;
    Functions: Record<never, never>;
    Enums: {
      modality: Modality;
      generation_status: GenerationStatus;
      message_role: MessageRole;
      asset_kind: AssetKind;
      asset_source: AssetSource;
      node_type: NodeType;
    };
    CompositeTypes: Record<never, never>;
  };
}

/** 数据库表名联合。 */
export type TableName = keyof Database['public']['Tables'];
