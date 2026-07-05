'use client';

/**
 * 「成组海报整组重新编排」钩子（第 05 篇第七节海报合成扩展）。
 *
 * 成组海报 = 一张背景图节点 + 若干同 `groupId` 的可编辑文字节点。本钩子把整组交给
 * `regenerate-poster` 边缘函数：以原背景图生图重生成新背景（原地落在背景节点）、并按海报
 * 编排 LLM 的新版式替换为新的可编辑文字节点（沿用同一 groupId，整组保持成组）。
 *
 * 背景的真实重生成与文字的删/建均在服务端完成，经实时回流到画布；本钩子只乐观地把背景节点
 * 就地置为占位（persist:false，写入权归服务端，避免与服务端 + 落库竞态），失败再还原。
 *
 * @module lib/hooks/use-regenerate-poster
 */

import { useCallback } from 'react';
import type { RegeneratePosterRequest, RegeneratePosterResponse } from '@/types';
import { EDGE_FUNCTIONS } from '@/types';
import { getBrowserSupabase } from '@/lib/supabase/client';
import { invokeEdge } from '@/lib/edge/client';
import { normalizeUnknownError } from '@/lib/edge/errors';
import { useCanvasStore } from '@/stores/canvas-store';
import { useChatStore } from '@/stores/chat-store';
import { nodeBox } from '@/lib/canvas/node-mapper';
import { collectGroupOverlays } from '@/lib/canvas/flatten';
import { buildPlaceholderNode } from './use-generation';
import type { RegenerateResult } from './use-regenerate-node';

/** useRegeneratePoster 返回值。 */
export interface UseRegeneratePoster {
  /** 以背景图节点定位其所在组，整组重新编排。 */
  regeneratePoster: (backgroundNodeId: string) => Promise<RegenerateResult>;
}

/**
 * 成组海报整组重新编排钩子。
 *
 * @returns 重新编排动作
 */
export function useRegeneratePoster(): UseRegeneratePoster {
  const regeneratePoster = useCallback(
    async (backgroundNodeId: string): Promise<RegenerateResult> => {
      const { nodes, projectId } = useCanvasStore.getState();
      if (!projectId) return { ok: false, reason: 'failed' };

      const node = nodes.find((n) => n.id === backgroundNodeId);
      if (!node || node.data.type !== 'image') return { ok: false, reason: 'not_media' };
      const groupId = node.data.groupId;
      if (!groupId) return { ok: false, reason: 'failed' };
      if (!node.data.assetId) return { ok: false, reason: 'no_asset' };

      // 解析一个支持图生图的活跃图像模型（背景需以原图为参考重生成）
      const supabase = getBrowserSupabase();
      const { data: model, error: modelError } = await supabase
        .from('model_catalog')
        .select('key')
        .eq('modality', 'image')
        .eq('is_active', true)
        .eq('capabilities->>supportsReferenceImages', 'true')
        .order('sort_order', { ascending: true })
        .limit(1)
        .maybeSingle();
      if (modelError) return { ok: false, reason: 'failed', message: modelError.message };
      if (!model) return { ok: false, reason: 'no_model' };

      // 乐观本地更新（均 persist:false → 写入权归服务端 + 实时回流，本地仅作即时反馈）：
      // - 背景节点就地置为占位（同 id、同框）；
      // - 旧叠层（同组的文字 / 形状 / 手绘）立即本地移除——与服务端将删除的集合一致，使「换图后旧
      //   文字残留」不依赖 realtime DELETE 才消失（即便该删除事件在断线窗口丢失也不会双份文字）。
      const box = nodeBox(node);
      const placement = {
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        parentId: node.parentId ?? null,
      };
      const overlays = collectGroupOverlays(nodes, node);
      const original = node;
      const store = useCanvasStore.getState();
      store.replaceNode(
        backgroundNodeId,
        buildPlaceholderNode({
          placement,
          modality: 'image',
          promptSummary: '重新编排海报…',
          nodeId: backgroundNodeId,
        }),
        { persist: false },
      );
      if (overlays.length > 0) {
        store.removeNodes(
          overlays.map((o) => o.id),
          { persist: false },
        );
      }

      try {
        await invokeEdge<RegeneratePosterRequest, RegeneratePosterResponse>(
          EDGE_FUNCTIONS.regeneratePoster,
          {
            projectId,
            conversationId: useChatStore.getState().conversationId,
            groupId,
            backgroundNodeId,
            modelKey: model.key,
          },
        );
        return { ok: true };
      } catch (err) {
        // 失败：本地还原背景与旧叠层（均 persist:false）；服务端若已部分提交，实时回流会校正
        const s = useCanvasStore.getState();
        s.replaceNode(backgroundNodeId, original, { persist: false });
        if (overlays.length > 0) s.addNodes(overlays, { select: false, persist: false });
        return { ok: false, reason: 'failed', message: normalizeUnknownError(err).message };
      }
    },
    [],
  );

  return { regeneratePoster };
}
