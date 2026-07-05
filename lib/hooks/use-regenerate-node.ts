'use client';

/**
 * 「以所选节点为参考、原地相似再生成」钩子（第 05 篇生成编排）。
 *
 * 与序列视频钩子（use-sequence-video）同源：直接经 submit-generation 提交一次生成，不绕对话
 * 编排。区别在于本钩子专做「单节点相似变体」：
 *
 *   1. 取选中的图片 / 视频节点的绑定资产，作为 `content`（图片）/ `first_frame`（视频）参考；
 *   2. 不送随机种子 → 每次产出都不同（「相似但不一成不变」）；
 *   3. 关键：把请求的 `placeholderNodeId` 设为「选中节点自身的 id」、`placement` 设为其当前
 *      位置与尺寸 —— 服务端据此原地把该节点改写为生成占位、完成后再落回相似新图，从而
 *      「替换的是选中节点本身，而非新建一个节点」。
 *
 * 图生图依赖图像模型声明 supportsReferenceImages（见迁移 0014 开启 Kolors）；图生视频依赖
 * 视频模型声明 supportsImageToVideo。无可用模型时返回 no_model 由调用方提示，绝不静默吞错。
 *
 * @module lib/hooks/use-regenerate-node
 */

import { useCallback } from 'react';
import type {
  AspectRatio,
  ImageGenerationParams,
  ModelCapabilities,
  ModelDefaultParams,
  NodePlacement,
  ReferenceMaterial,
  UnifiedGenerationRequest,
  VideoGenerationParams,
} from '@/types';
import { getBrowserSupabase } from '@/lib/supabase/client';
import { useCanvasStore } from '@/stores/canvas-store';
import { useChatStore } from '@/stores/chat-store';
import { nodeBox } from '@/lib/canvas/node-mapper';
import { getImageDescription } from '@/lib/canvas/annotation';
import { idempotencyKey } from '@/lib/utils/id';
import { normalizeUnknownError } from '@/lib/edge/errors';
import { buildPlaceholderNode, useGeneration } from './use-generation';

/**
 * 再生成结果：成功，或带原因的失败（供调用方本地化提示）。
 * - not_media：选中的不是图片 / 视频节点；
 * - no_asset：节点尚未绑定可参考的媒体资产；
 * - no_model：当前无支持图生图 / 图生视频的活跃模型；
 * - failed：提交或其它运行期失败（message 仅供排查）。
 */
export type RegenerateResult =
  | { ok: true }
  | { ok: false; reason: 'not_media' | 'no_asset' | 'no_model' | 'failed'; message?: string };

/** useRegenerateNode 返回值。 */
export interface UseRegenerateNode {
  /** 以选中节点为参考、原地生成相似变体。 */
  regenerate: (nodeId: string) => Promise<RegenerateResult>;
}

/** 图片相似变体的基础提示词（图生图：参考图承载主体，文字仅作风格约束）。 */
const SIMILAR_IMAGE_PROMPT =
  '以所选图片为参考，生成一张主体、风格、配色与构图都与之相似的全新变体；保持整体观感一致，可在细节、光影与姿态上自然变化。画面中不要出现多余文字。';

/** 视频相似变体的基础提示词（图生视频：参考帧承载画面）。 */
const SIMILAR_VIDEO_PROMPT =
  '以所选画面为参考，生成一段风格与主体相似的短视频，运镜自然、过渡平滑。';

/** 占位卡片上的简短描述。 */
const REGEN_SUMMARY = '以参考生成相似变体';

/**
 * 依节点当前朝向，从模型支持的比例集合里挑一个最贴合的输出比例。
 * 竖图优先 3:4、横/方图优先 1:1；模型都不支持时退回其默认比例。
 */
function pickAspectRatio(
  box: { width: number; height: number },
  caps: ModelCapabilities,
  defaults: ModelDefaultParams,
): AspectRatio {
  const desired: AspectRatio = box.height > box.width ? '3:4' : '1:1';
  if (caps.aspectRatios.includes(desired)) return desired;
  if (defaults.aspectRatio && caps.aspectRatios.includes(defaults.aspectRatio)) {
    return defaults.aspectRatio;
  }
  return caps.aspectRatios[0] ?? '1:1';
}

/** 由比例字面量（如 '16:9'）按基准宽换算落位尺寸。 */
function sizeFromAspect(aspect: AspectRatio, baseWidth: number): { width: number; height: number } {
  const [w, h] = aspect.split(':').map(Number);
  if (!w || !h) return { width: baseWidth, height: Math.round((baseWidth * 9) / 16) };
  return { width: baseWidth, height: Math.round((baseWidth * h) / w) };
}

/**
 * 原地相似再生成钩子。
 *
 * @returns 再生成动作
 */
export function useRegenerateNode(): UseRegenerateNode {
  const { submit } = useGeneration();

  const regenerate = useCallback(
    async (nodeId: string): Promise<RegenerateResult> => {
      const { nodes, edges, projectId } = useCanvasStore.getState();
      if (!projectId) return { ok: false, reason: 'failed' };

      const node = nodes.find((n) => n.id === nodeId);
      if (!node) return { ok: false, reason: 'failed' };
      if (node.data.type !== 'image' && node.data.type !== 'video') {
        return { ok: false, reason: 'not_media' };
      }
      const assetId = node.data.assetId;
      if (!assetId) return { ok: false, reason: 'no_asset' };

      const modality = node.data.type; // 'image' | 'video'
      const supabase = getBrowserSupabase();

      // 解析一个能消费参考图的活跃模型：图片要支持参考图（图生图），视频要支持图生视频。
      // 无符合者即 no_model，避免选到不支持的模型致提交后被服务端 validateParams 拒绝。
      const refColumn =
        modality === 'video'
          ? 'capabilities->>supportsImageToVideo'
          : 'capabilities->>supportsReferenceImages';
      const { data: model, error: modelError } = await supabase
        .from('model_catalog')
        .select('key, default_params, capabilities')
        .eq('modality', modality)
        .eq('is_active', true)
        .eq(refColumn, 'true')
        .order('sort_order', { ascending: true })
        .limit(1)
        .maybeSingle();
      if (modelError) return { ok: false, reason: 'failed', message: modelError.message };
      if (!model) return { ok: false, reason: 'no_model' };

      const caps = model.capabilities as ModelCapabilities;
      const defaults = (model.default_params ?? {}) as ModelDefaultParams;

      const box = nodeBox(node);

      // 参考素材：选中节点绑定的资产（图片作内容参考、视频作首帧参考）
      const references: ReferenceMaterial[] = [
        {
          origin: 'node',
          nodeId,
          assetId,
          role: modality === 'video' ? 'first_frame' : 'content',
        },
      ];

      // 提示词：基础相似指令 + 连到该节点的「描述」便签（若有，作为额外可控指引）
      const description = getImageDescription(nodes, edges, nodeId);
      const basePrompt = modality === 'video' ? SIMILAR_VIDEO_PROMPT : SIMILAR_IMAGE_PROMPT;
      const prompt = description ? `${basePrompt}\n额外要求：${description}` : basePrompt;

      // 参数与落位：
      // - 图片：输出比例偏向源框朝向（pickAspectRatio），落位完全沿用源框 → 真正「原地」；
      // - 视频：输出比例取模型默认，落位据该比例在源框中心重定尺寸，避免 16:9 视频落入非
      //   16:9 的源框被 object-cover 裁切（与 use-sequence-video 的 sizeFromAspect 同源）。
      let params: ImageGenerationParams | VideoGenerationParams;
      let placement: NodePlacement;
      if (modality === 'video') {
        const aspectRatio = (defaults.aspectRatio ?? '16:9') as AspectRatio;
        params = {
          modality: 'video',
          durationSec: Number(defaults.durationSec ?? 5),
          resolution: String(defaults.resolution ?? '720p'),
          aspectRatio,
          fps: Number(defaults.fps ?? 24),
          references,
        };
        const size = sizeFromAspect(aspectRatio, box.width);
        placement = {
          x: box.x + box.width / 2 - size.width / 2,
          y: box.y + box.height / 2 - size.height / 2,
          width: size.width,
          height: size.height,
          parentId: node.parentId ?? null,
        };
      } else {
        params = {
          modality: 'image',
          aspectRatio: pickAspectRatio(box, caps, defaults),
          count: 1,
          references,
          // 刻意不送 seed → 每次随机，产出相似但不雷同
        };
        placement = {
          x: box.x,
          y: box.y,
          width: box.width,
          height: box.height,
          parentId: node.parentId ?? null,
        };
      }

      // 即时原地反馈：把选中节点就地替换为生成占位（同一 id、同一落位）。
      // 关键（persist:false）：这一行的写入权完全归服务端——createGeneration 会 upsert 该占位、
      // landResult 落回新图、再经实时回流到画布。客户端只做本地即时替换、绝不回写此行，否则
      // 600ms 防抖的占位写可能与服务端「同步落图」竞态，把已生成的图覆盖回空占位（丢图）。
      const original = node;
      useCanvasStore.getState().replaceNode(
        nodeId,
        buildPlaceholderNode({ placement, modality, promptSummary: REGEN_SUMMARY, nodeId }),
        { persist: false },
      );

      try {
        const request: UnifiedGenerationRequest = {
          projectId,
          conversationId: useChatStore.getState().conversationId,
          messageId: null,
          modality,
          modelKey: model.key,
          prompt,
          params,
          idempotencyKey: idempotencyKey(),
          placement,
          // 关键：占位 id = 选中节点 id → 服务端原地改写该节点，完成后落回相似新图
          placeholderNodeId: nodeId,
        };
        await submit(request);
        return { ok: true };
      } catch (err) {
        // 提交失败：本地还原原节点（同样 persist:false）。提交前的失败（校验 / 限流 / 网络）
        // 服务端未写库，DB 仍是原节点，本地还原即与 DB 一致；万一服务端已提交，实时回流会以
        // 服务端状态校正，本地还原只是过渡，不与服务端竞态写库。
        useCanvasStore.getState().replaceNode(nodeId, original, { persist: false });
        return { ok: false, reason: 'failed', message: normalizeUnknownError(err).message };
      }
    },
    [submit],
  );

  return { regenerate };
}
