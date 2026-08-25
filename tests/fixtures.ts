import { createDefaultNodeDataUnion, DEFAULT_NODE_SIZE } from '@/lib/canvas/constants';
import { rowToNode, type CanvasFlowNode } from '@/lib/canvas/node-mapper';
import type { CanvasNodeRow, ConversationRow, GenerationRow, MessageRow, NodeType } from '@/types';

export const TEST_NOW = '2026-08-25T08:00:00.000Z';

/** 构造一条完整 canvas_nodes 测试行。 */
export function canvasNodeRow(
  id: string,
  type: NodeType = 'shape',
  overrides: Partial<CanvasNodeRow> = {},
): CanvasNodeRow {
  const size = DEFAULT_NODE_SIZE[type];
  return {
    id,
    project_id: 'project-1',
    type,
    position_x: 0,
    position_y: 0,
    width: size.width,
    height: size.height,
    rotation: 0,
    z_index: 0,
    parent_id: null,
    data: createDefaultNodeDataUnion(type) as CanvasNodeRow['data'],
    asset_id: null,
    generation_id: null,
    created_by: 'user-1',
    created_at: TEST_NOW,
    updated_at: TEST_NOW,
    ...overrides,
  };
}

/** 构造 React Flow 节点。 */
export function canvasNode(
  id: string,
  type: NodeType = 'shape',
  overrides: Partial<CanvasNodeRow> = {},
): CanvasFlowNode {
  return rowToNode(canvasNodeRow(id, type, overrides));
}

/** 构造项目会话。 */
export function conversationRow(id: string, title = id): ConversationRow {
  return {
    id,
    project_id: 'project-1',
    title,
    target_node_id: null,
    created_at: TEST_NOW,
    updated_at: TEST_NOW,
  };
}

/** 构造数据库消息。 */
export function messageRow(
  id: string,
  role: MessageRow['role'],
  overrides: Partial<MessageRow> = {},
): MessageRow {
  return {
    id,
    conversation_id: 'conversation-1',
    role,
    content: id,
    model_key: null,
    agent_mode: null,
    user_message_id: null,
    mentions: [],
    attachments: [],
    created_at: TEST_NOW,
    ...overrides,
  };
}

/** 构造完整生成任务行。 */
export function generationRow(id: string, overrides: Partial<GenerationRow> = {}): GenerationRow {
  return {
    id,
    project_id: 'project-1',
    conversation_id: 'conversation-1',
    message_id: null,
    modality: 'image',
    model_key: 'test-image',
    provider: 'openai',
    prompt: 'test',
    params: { modality: 'image', count: 1, references: [] },
    status: 'pending',
    progress: 0,
    external_job_id: null,
    result_asset_id: null,
    placeholder_node_id: null,
    target_node_id: null,
    result_mode: 'new_primary',
    error: null,
    idempotency_key: id,
    requester_id: 'user-1',
    operation_type: 'generation',
    request_hash: 'hash',
    submission_queue_message_id: null,
    provider_output_summary: null,
    webhook_secret_hash: null,
    webhook_secret_expires_at: null,
    poll_lease_token: null,
    poll_lease_until: null,
    moderation_status: 'passed',
    moderation_reason: null,
    created_at: TEST_NOW,
    updated_at: TEST_NOW,
    completed_at: null,
    ...overrides,
  };
}
