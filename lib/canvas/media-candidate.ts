/**
 * 媒体候选关系边。
 *
 * 该边只表达「主媒体节点 -> 候选历史节点」的归属关系，不参与工作流序列、描述或血缘线逻辑。
 *
 * @module lib/canvas/media-candidate
 */

import { MarkerType, type EdgeMarker } from '@xyflow/react';
import type { CanvasFlowEdge } from './node-mapper';

/** 媒体候选边类型。 */
export const MEDIA_CANDIDATE_EDGE_TYPE = 'media_candidate' as const;

/** 主媒体候选关系出桩。 */
export const MEDIA_CANDIDATE_HANDLE_OUT = 'media-candidate-out';

/** 候选媒体关系入桩。 */
export const MEDIA_CANDIDATE_HANDLE_IN = 'media-candidate-in';

/** 候选关系边箭头。 */
export const MEDIA_CANDIDATE_MARKER_END: EdgeMarker = {
  type: MarkerType.ArrowClosed,
  width: 12,
  height: 12,
  color: 'hsl(var(--accent))',
};

/**
 * 为媒体候选边附加专属渲染装饰。
 *
 * @param edge - 基础边
 * @returns 带候选关系样式标记的边
 */
export function decorateMediaCandidateEdge(edge: CanvasFlowEdge): CanvasFlowEdge {
  return {
    ...edge,
    type: MEDIA_CANDIDATE_EDGE_TYPE,
    animated: false,
    markerEnd: MEDIA_CANDIDATE_MARKER_END,
  };
}
