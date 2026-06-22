'use client';

/**
 * 生成领域钩子：提交生成、失败重试，以及构造画布占位节点（第 05 篇第五节）。
 *
 * 提交经 submit-generation 能力面函数完成（建任务 + 建占位 + 入队），后续进度与结果
 * 经实时面回流。为即时反馈，调用方可先以客户端占位 id 落一个占位节点，提交时带上该 id，
 * 服务端据此 upsert 同一节点，避免与回流重复。
 *
 * @module lib/hooks/use-generation
 */

import { useCallback } from 'react';
import type {
  GenerationParams,
  GenerationRow,
  Modality,
  NodePlacement,
  SubmitGenerationRequest,
  SubmitGenerationResponse,
  UnifiedGenerationRequest,
} from '@/types';
import { EDGE_FUNCTIONS } from '@/types';
import { getBrowserSupabase } from '@/lib/supabase/client';
import { invokeEdge } from '@/lib/edge/client';
import { normalizeUnknownError } from '@/lib/edge/errors';
import { useCanvasStore } from '@/stores/canvas-store';
import type { CanvasFlowNode } from '@/lib/canvas/node-mapper';
import { idempotencyKey, uuid } from '@/lib/utils/id';
import { createDefaultNodeData } from '@/lib/canvas/constants';

/** 构造占位节点的参数。 */
export interface BuildPlaceholderParams {
  /** 占位落位（flow 坐标与尺寸）。 */
  placement: NodePlacement;
  /** 目标模态。 */
  modality: Extract<Modality, 'image' | 'video'>;
  /** 提示词摘要。 */
  promptSummary: string;
  /** 客户端占位 id（与 submit-generation 一致）。 */
  nodeId?: string;
}

/**
 * 构造一个生成占位节点（含客户端 id）。
 *
 * @param params - 构造参数
 * @returns React Flow 占位节点
 */
export function buildPlaceholderNode(params: BuildPlaceholderParams): CanvasFlowNode {
  const { placement, modality, promptSummary } = params;
  const id = params.nodeId ?? uuid();
  const data = createDefaultNodeData('generation_placeholder', {
    targetModality: modality,
    promptSummary,
    targetWidth: placement.width,
    targetHeight: placement.height,
    progress: 0,
    statusLabel: 'pending',
  });
  const node: CanvasFlowNode = {
    id,
    type: 'generation_placeholder',
    position: { x: placement.x, y: placement.y },
    data,
    width: placement.width,
    height: placement.height,
    zIndex: 0,
    style: { width: placement.width, height: placement.height },
  };
  if (placement.parentId) {
    node.parentId = placement.parentId;
    node.extent = 'parent';
  }
  return node;
}

/** useGeneration 返回值。 */
export interface UseGeneration {
  /** 提交一次生成。 */
  submit: (request: SubmitGenerationRequest) => Promise<SubmitGenerationResponse>;
  /** 以原参数重试一次失败的生成（新建任务）。 */
  retry: (generationId: string, placement?: NodePlacement) => Promise<SubmitGenerationResponse>;
}

/**
 * 生成钩子。
 *
 * @returns 提交与重试动作
 */
export function useGeneration(): UseGeneration {
  const submit = useCallback(async (request: SubmitGenerationRequest) => {
    try {
      return await invokeEdge<UnifiedGenerationRequest, SubmitGenerationResponse>(
        EDGE_FUNCTIONS.submitGeneration,
        request,
      );
    } catch (err) {
      throw normalizeUnknownError(err);
    }
  }, []);

  const retry = useCallback(
    async (generationId: string, placement?: NodePlacement) => {
      const supabase = getBrowserSupabase();
      const { data, error } = await supabase
        .from('generations')
        .select('*')
        .eq('id', generationId)
        .single();
      if (error || !data) {
        throw normalizeUnknownError(error ?? new Error('生成任务不存在'));
      }
      const row = data as GenerationRow;

      // 以原参数新建一条任务（不复用失败记录，保审计清晰）
      const newPlaceholderId = uuid();
      const effectivePlacement: NodePlacement =
        placement ?? {
          x: 0,
          y: 0,
          width: 320,
          height: 320,
        };

      // 即时落一个新占位
      if (row.modality === 'image' || row.modality === 'video') {
        useCanvasStore.getState().addNode(
          buildPlaceholderNode({
            placement: effectivePlacement,
            modality: row.modality,
            promptSummary: row.prompt ?? '',
            nodeId: newPlaceholderId,
          }),
        );
      }

      const request: UnifiedGenerationRequest = {
        projectId: row.project_id,
        conversationId: row.conversation_id,
        messageId: row.message_id,
        modality: row.modality,
        modelKey: row.model_key,
        prompt: row.prompt ?? '',
        params: row.params as GenerationParams,
        idempotencyKey: idempotencyKey(),
        placement: effectivePlacement,
        placeholderNodeId: newPlaceholderId,
      };

      return submit(request);
    },
    [submit],
  );

  return { submit, retry };
}
