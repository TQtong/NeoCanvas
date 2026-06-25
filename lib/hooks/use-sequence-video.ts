'use client';

/**
 * 序列视频生成钩子（第 05 篇生成编排）。
 *
 * 把用户在画布上用 `sequence` 边串成的「有序图片链」提交为一次「逐段首尾帧」视频生成：
 * 解析链 → 取各成员资产为有序关键帧 → 解析当前可用的视频模型 → 在链右侧落一个视频占位节点
 * → 经 submit-generation 入流水线。相邻两关键帧构成一段（前者首帧、后者尾帧），各段拼接为
 * 一条完整视频；段合成与拼接在服务端完成（依赖已激活的视频模型与对应密钥）。
 *
 * 本钩子是完整真实链路：当环境尚无可用视频模型时，返回 `no_model` 由调用方提示，不落占位、
 * 不静默吞错。
 *
 * @module lib/hooks/use-sequence-video
 */

import { useCallback } from 'react';
import type {
  AspectRatio,
  NodePlacement,
  ReferenceMaterial,
  UnifiedGenerationRequest,
  VideoGenerationParams,
} from '@/types';
import { getBrowserSupabase } from '@/lib/supabase/client';
import { useCanvasStore } from '@/stores/canvas-store';
import { useChatStore } from '@/stores/chat-store';
import { nodeBox, type CanvasFlowNode } from '@/lib/canvas/node-mapper';
import { resolveSequenceChain } from '@/lib/canvas/sequence';
import { getImageDescription } from '@/lib/canvas/annotation';
import { idempotencyKey, uuid } from '@/lib/utils/id';
import { normalizeUnknownError } from '@/lib/edge/errors';
import { buildPlaceholderNode, useGeneration } from './use-generation';

/** 新建视频占位与链的水平间距（flow 像素）。 */
const VIDEO_GAP = 80;
/** 视频占位基准宽（flow 像素），高由比例换算。 */
const VIDEO_BASE_WIDTH = 360;

/** 生成结果：成功，或带原因的失败（供调用方本地化提示）。 */
export type SequenceVideoResult =
  | { ok: true }
  | { ok: false; reason: 'too_short' | 'no_model' | 'failed'; message?: string };

/** useSequenceVideo 返回值。 */
export interface UseSequenceVideo {
  /** 解析节点所在链并提交「逐段首尾帧」视频生成。 */
  generate: (nodeId: string) => Promise<SequenceVideoResult>;
}

/** 由比例字面量（如 '16:9'）换算占位尺寸。 */
function sizeFromAspect(aspect: AspectRatio): { width: number; height: number } {
  const [w, h] = aspect.split(':').map(Number);
  if (!w || !h) return { width: VIDEO_BASE_WIDTH, height: Math.round((VIDEO_BASE_WIDTH * 9) / 16) };
  return { width: VIDEO_BASE_WIDTH, height: Math.round((VIDEO_BASE_WIDTH * h) / w) };
}

/** 取链成员的包围盒（flow 坐标）。 */
function chainBounds(members: CanvasFlowNode[]): { right: number; top: number; bottom: number } {
  const boxes = members.map(nodeBox);
  return {
    right: Math.max(...boxes.map((b) => b.x + b.width)),
    top: Math.min(...boxes.map((b) => b.y)),
    bottom: Math.max(...boxes.map((b) => b.y + b.height)),
  };
}

/**
 * 序列视频生成钩子。
 *
 * @returns 生成动作
 */
export function useSequenceVideo(): UseSequenceVideo {
  const { submit } = useGeneration();

  const generate = useCallback(
    async (nodeId: string): Promise<SequenceVideoResult> => {
      const { nodes, edges, projectId } = useCanvasStore.getState();
      if (!projectId) return { ok: false, reason: 'failed' };

      // 解析链并取有效关键帧（已绑定资产的图片 / 视频成员，顺序即合成顺序）
      const chain = resolveSequenceChain(nodes, edges, nodeId);
      const members: Array<{ node: CanvasFlowNode; assetId: string }> = [];
      for (const n of chain.nodes) {
        if ((n.data.type === 'image' || n.data.type === 'video') && n.data.assetId) {
          members.push({ node: n, assetId: n.data.assetId });
        }
      }
      if (members.length < 2) return { ok: false, reason: 'too_short' };

      // 解析当前可用的视频模型：必须 active 且声明支持「关键帧序列」（逐段首尾帧），按排序取首个；
      // 无符合者即 no_model，避免选到仅单首帧的图生视频模型致提交后被服务端校验拒绝
      const supabase = getBrowserSupabase();
      const { data: model, error: modelError } = await supabase
        .from('model_catalog')
        .select('key, default_params')
        .eq('modality', 'video')
        .eq('is_active', true)
        .eq('capabilities->>supportsKeyframeSequence', 'true')
        .order('sort_order', { ascending: true })
        .limit(1)
        .maybeSingle();
      if (modelError) return { ok: false, reason: 'failed', message: modelError.message };
      if (!model) return { ok: false, reason: 'no_model' };

      const dp = (model.default_params ?? {}) as Record<string, unknown>;
      const resolution = typeof dp.resolution === 'string' ? dp.resolution : '720p';
      const durationSec = typeof dp.durationSec === 'number' ? dp.durationSec : 5;
      const fps = typeof dp.fps === 'number' ? dp.fps : 24;
      const aspectRatio: AspectRatio =
        typeof dp.aspectRatio === 'string' ? (dp.aspectRatio as AspectRatio) : '16:9';

      // 落位：链右侧空白，垂直居中对齐链
      const bounds = chainBounds(members.map((m) => m.node));
      const size = sizeFromAspect(aspectRatio);
      const placement: NodePlacement = {
        x: bounds.right + VIDEO_GAP,
        y: (bounds.top + bounds.bottom) / 2 - size.height / 2,
        width: size.width,
        height: size.height,
        parentId: null,
      };

      // 有序关键帧（role: keyframe，顺序即合成顺序）
      const keyframes: ReferenceMaterial[] = members.map((m) => ({
        origin: 'node',
        nodeId: m.node.id,
        assetId: m.assetId,
        role: 'keyframe',
      }));

      // 逐帧描述（来自连到各图的文字便签）按序拼进提示词，让过渡更贴合用户意图
      const frameLines = members.map((m, i) => {
        const desc = getImageDescription(nodes, edges, m.node.id);
        return desc ? `第 ${i + 1} 帧：${desc}` : `第 ${i + 1} 帧：（无额外描述，沿用画面）`;
      });
      const prompt =
        `按以下 ${members.length} 个关键帧顺序生成一段连贯过渡视频，相邻两帧之间平滑过渡：\n` +
        frameLines.join('\n');
      const summary = `按 ${members.length} 帧顺序生成视频`;
      const params: VideoGenerationParams = {
        modality: 'video',
        durationSec,
        resolution,
        aspectRatio,
        fps,
        references: [],
        keyframes,
      };

      // 即时落视频占位节点（与回流去重经客户端占位 id）
      const placeholderNodeId = uuid();
      useCanvasStore.getState().addNode(
        buildPlaceholderNode({
          placement,
          modality: 'video',
          promptSummary: summary,
          nodeId: placeholderNodeId,
        }),
      );

      const request: UnifiedGenerationRequest = {
        projectId,
        conversationId: useChatStore.getState().conversationId,
        messageId: null,
        modality: 'video',
        modelKey: model.key,
        prompt,
        params,
        idempotencyKey: idempotencyKey(),
        placement,
        placeholderNodeId,
      };

      try {
        await submit(request);
        return { ok: true };
      } catch (err) {
        // 提交失败：撤回占位，避免遗留「永久生成中」的孤儿节点
        useCanvasStore.getState().removeNodes([placeholderNodeId]);
        return { ok: false, reason: 'failed', message: normalizeUnknownError(err).message };
      }
    },
    [submit],
  );

  return { generate };
}
