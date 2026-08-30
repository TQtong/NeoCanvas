/**
 * 能力面（Edge Functions）面向客户端的输入 / 输出契约。
 *
 * 前端 `lib/edge` 调用封装与各 Edge Function 共同引用本模块，确保两端对请求 / 响应
 * 形状的理解一致（第 06 篇第四节）。内部型函数（消费队列、轮询、回调）不面向客户端，
 * 其契约在各自实现内定义。
 *
 * @module types/edge-functions
 */

import type { AgentMode, Scene } from './enums';
import type { MessageAttachment, MessageMention } from './messages';
import type { UnifiedGenerationRequest } from './generation';

/** Edge Function 逻辑名常量，供调用封装与路由共用。 */
export const EDGE_FUNCTIONS = {
  createProject: 'create-project',
  submitGeneration: 'submit-generation',
  agentOrchestrate: 'agent-orchestrate',
  exportCanvas: 'export-canvas',
  processGenerationQueue: 'process-generation-queue',
  pollGenerations: 'poll-generations',
  cleanupGenerationStaging: 'cleanup-generation-staging',
  generationWebhook: 'generation-webhook',
  regeneratePoster: 'regenerate-poster',
  providerCredentials: 'provider-credentials',
  swapMediaCandidate: 'swap-media-candidate',
  workflowExecute: 'workflow-execute',
  workflowAgent: 'workflow-agent',
  workflowPublish: 'workflow-publish',
  processWorkflowQueue: 'process-workflow-queue',
} as const;

/** create-project 请求。 */
export interface CreateProjectRequest {
  /** 初始想法（提示词文本）。 */
  prompt: string;
  /** 所选模型键；空白项目可为空，进入即生成时必须提供。 */
  modelKey: string | null;
  /** 所选场景（可空）。 */
  scene: Scene | null;
  /** 可选附件资产引用。 */
  attachments?: MessageAttachment[];
  /** 是否进入即生成首图（产品策略）。 */
  generateOnCreate: boolean;
  /** 客户端请求标识，避免连点重复建项目。 */
  clientRequestId?: string;
}

/** create-project 响应。 */
export interface CreateProjectResponse {
  /** 新项目标识，供重定向至 p/{projectId}。 */
  projectId: string;
  /** 主会话标识。 */
  conversationId: string;
  /** 首条用户消息标识。 */
  messageId: string;
  /** 若进入即生成，首个生成任务标识。 */
  generationId: string | null;
  /** 若进入即生成，画布占位节点标识。 */
  placeholderNodeId: string | null;
}

/** submit-generation 请求，即统一生成请求。 */
export type SubmitGenerationRequest = UnifiedGenerationRequest;

/** submit-generation 响应。 */
export interface SubmitGenerationResponse {
  /** 生成任务标识。 */
  generationId: string;
  /** 画布占位节点标识。 */
  placeholderNodeId: string;
  /** 是否为幂等命中（复用既有任务）。 */
  deduplicated: boolean;
  /** 原子提交涉及的节点（占位及候选面板）标识。 */
  nodeIds?: string[];
  /** 原子提交涉及的候选关系边标识。 */
  edgeIds?: string[];
  /** 持久队列消息标识（bigint 以字符串跨越 JSON 边界）。 */
  queueMessageId?: string | null;
}

/** 数据库原子提交 RPC 的完整返回契约。 */
export interface GenerationSubmissionResult {
  generationId: string;
  placeholderNodeId: string;
  nodeIds: string[];
  edgeIds: string[];
  queueMessageId: string | null;
  reused: boolean;
}

/** 单次结果落库 RPC 的返回契约。 */
export interface LandGenerationResult {
  landed: boolean;
  generationId: string;
  terminalStatus: 'succeeded' | 'failed' | 'cancelled';
  assetIds: string[];
  nodeIds: string[];
}

/** 候选采用时的节点几何策略。 */
export const CANDIDATE_GEOMETRY_MODES = ['preserve_frame', 'adopt_output_geometry'] as const;
export type CandidateGeometryMode = (typeof CANDIDATE_GEOMETRY_MODES)[number];

/** swap-media-candidate 请求。 */
export interface SwapMediaCandidateRequest {
  /** 当前项目。 */
  projectId: string;
  /** 主媒体节点 id。 */
  primaryNodeId: string;
  /** 候选媒体节点 id。 */
  candidateNodeId: string;
  /** 保留主节点外框，或在扩图时采用候选输出几何。 */
  geometryMode: CandidateGeometryMode;
}

/** swap-media-candidate 响应。 */
export interface SwapMediaCandidateResponse {
  /** 是否完成替换。 */
  swapped: boolean;
}

/** agent-orchestrate 请求。 */
export interface AgentOrchestrateRequest {
  /** 项目标识。 */
  projectId: string;
  /** 会话标识。 */
  conversationId: string;
  /** 用户消息标识（客户端乐观写入后传入，用于去重）。 */
  messageId: string;
  /** 用户消息内容。 */
  content: string;
  /** 所选 Agent 模式。 */
  agentMode: AgentMode;
  /** 所选模型键。 */
  modelKey: string;
  /** `@` 提及的画布节点引用。 */
  mentions: MessageMention[];
  /** 附件资产引用。 */
  attachments: MessageAttachment[];
}

/**
 * agent-orchestrate 流式事件（SSE / 流式分块）。文本回复边生成边返回；
 * 图 / 视频走异步生成流水线，稍后经实时面落画布，这里仅回传其任务标识。
 */
export type AgentOrchestrateEvent =
  | { type: 'message_created'; assistantMessageId: string }
  | { type: 'text_delta'; delta: string }
  | { type: 'generation_started'; generationId: string; placeholderNodeId: string }
  | { type: 'done'; assistantMessageId: string; generationIds: string[] }
  | { type: 'error'; code: string; message: string };

/**
 * regenerate-poster 请求：以「成组海报」（背景图节点 + 同组文字节点）为参考，整组重新编排。
 *
 * 服务端：由现有文字重建主题 → 海报编排 LLM 产出新背景提示词与新文字版式 → 背景以图生图
 * 原地落在背景节点（placeholderNodeId = backgroundNodeId、参考原背景图）→ 删旧文字、建新的
 * 可编辑文字节点（沿用同一 groupId，使整组保持成组）。
 */
export interface RegeneratePosterRequest {
  /** 项目标识。 */
  projectId: string;
  /** 会话标识（可空）。 */
  conversationId: string | null;
  /** 海报逻辑组标识（同 groupId 的成员构成一张海报）。 */
  groupId: string;
  /** 作底图的背景图片节点标识（原地以其为占位重生成背景）。 */
  backgroundNodeId: string;
  /** 用于背景图生图的图像模型键。 */
  modelKey: string;
}

/** regenerate-poster 响应。 */
export interface RegeneratePosterResponse {
  /** 背景重生成任务标识。 */
  generationId: string;
  /** 背景占位节点标识（即 backgroundNodeId，原地）。 */
  placeholderNodeId: string;
  /** 新建的可编辑文字节点标识集合。 */
  textNodeIds: string[];
  /** 编排助手回复（说明本次海报构思）。 */
  reply: string;
}

/** export-canvas 选项。 */
export interface ExportCanvasOptions {
  /** 导出范围：整块画布或仅某画板 / 选区。 */
  scope: 'all' | 'frame' | 'selection';
  /** 当 scope 为 frame：目标画板节点标识。 */
  frameNodeId?: string;
  /** 当 scope 为 selection：选中节点标识集合。 */
  nodeIds?: string[];
  /** 输出格式。 */
  format: 'png' | 'jpeg' | 'svg' | 'pdf';
  /** 输出倍率（1..4）。 */
  scale: number;
}

/** export-canvas 请求。 */
export interface ExportCanvasRequest {
  /** 项目标识。 */
  projectId: string;
  /** 导出选项。 */
  options: ExportCanvasOptions;
}

/** export-canvas 响应。 */
export interface ExportCanvasResponse {
  /** 短时效签名下载链接。 */
  downloadUrl: string;
  /** 链接过期时间（ISO 字符串）。 */
  expiresAt: string;
  /** 导出件 MIME。 */
  mimeType: string;
}
