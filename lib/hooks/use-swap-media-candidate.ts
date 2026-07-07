'use client';

/**
 * 候选媒体替换主媒体的客户端封装。
 *
 * @module lib/hooks/use-swap-media-candidate
 */

import { useCallback } from 'react';
import type { SwapMediaCandidateRequest, SwapMediaCandidateResponse } from '@/types';
import { EDGE_FUNCTIONS } from '@/types';
import { invokeEdge } from '@/lib/edge/client';
import { normalizeUnknownError } from '@/lib/edge/errors';

/** useSwapMediaCandidate 返回值。 */
export interface UseSwapMediaCandidate {
  /** 用候选媒体替换主媒体，旧主媒体会保留在候选节点。 */
  swap: (request: SwapMediaCandidateRequest) => Promise<SwapMediaCandidateResponse>;
}

/** 候选替换 Hook。 */
export function useSwapMediaCandidate(): UseSwapMediaCandidate {
  const swap = useCallback(async (request: SwapMediaCandidateRequest) => {
    try {
      return await invokeEdge<SwapMediaCandidateRequest, SwapMediaCandidateResponse>(
        EDGE_FUNCTIONS.swapMediaCandidate,
        request,
      );
    } catch (err) {
      throw normalizeUnknownError(err);
    }
  }, []);

  return { swap };
}
