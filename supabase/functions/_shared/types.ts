/**
 * Edge Function 契约出口。
 *
 * 业务枚举、API、生成、模型与 Provider 契约全部由根 `types/` 确定性生成；本文件只保留
 * Edge 内部需要的 snake_case 数据库行投影。禁止在这里重声明公开业务契约。
 *
 * @module functions/_shared/types
 */

export * from './contracts.generated.ts';
export { TERMINAL_GENERATION_STATUSES as TERMINAL_STATUSES } from './contracts.generated.ts';

import {
  type GenerationParams,
  type GenerationResultMode,
  type GenerationStatus,
  type Modality,
  type ModelCapabilities,
  type ModelDefaultParams,
  type Provider,
} from './contracts.generated.ts';

/** 数据库 `model_catalog` 行（Edge 流水线读取字段）。 */
export interface ModelCatalogRow {
  key: string;
  display_name: string;
  provider: Provider;
  modality: Modality;
  capabilities: ModelCapabilities;
  default_params: ModelDefaultParams;
  is_active: boolean;
  user_id: string | null;
  sort_order: number;
}

/** 数据库 `generations` 行（Edge 流水线读取字段）。 */
export interface GenerationRow {
  id: string;
  created_at: string;
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
  result_mode: GenerationResultMode;
  error: string | null;
  idempotency_key: string | null;
  requester_id: string;
  operation_type: string;
  request_hash: string | null;
  submission_queue_message_id: number | null;
  provider_output_summary: Record<string, unknown> | null;
  webhook_secret_hash: string | null;
  webhook_secret_expires_at: string | null;
  poll_lease_token: string | null;
  poll_lease_until: string | null;
  moderation_status: string;
  moderation_reason: string | null;
  completed_at: string | null;
  workflow_run_node_id: string | null;
}
