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
import type { GenerationParams } from './generation';

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
}

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
  created_at: string;
  updated_at: string;
  last_opened_at: string | null;
}

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
}

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
}

/** `conversations` 表行。 */
export type ConversationRow = {
  id: string;
  project_id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

/** `messages` 表行。 */
export type MessageRow = {
  id: string;
  conversation_id: string;
  role: MessageRole;
  content: string | null;
  model_key: string | null;
  agent_mode: string | null;
  mentions: MessageMention[];
  attachments: MessageAttachment[];
  created_at: string;
}

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
  error: string | null;
  idempotency_key: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

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
  created_at: string;
}

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
  created_at: string;
}

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
