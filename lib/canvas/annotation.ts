/**
 * 图片描述（annotation）边算法（第 04 篇画布连线、第 05 篇生成编排）。
 *
 * 用户用 `annotation` 类型的边把一个文字节点连到某张图片 / 视频节点，使该文字成为这张图的
 * 「描述 / 提示词」——说明 AI 应如何理解这张图、想要什么效果。生成序列视频时，各帧的描述
 * 按链顺序拼进提示词，让过渡更贴合用户意图。
 *
 * 约定：描述是「一对一」的——每张图至多一条描述、每个文字便签至多描述一张图（由
 * {@link stores/canvas-store} 的 `addAnnotationEdge` 在连接时强制）。本模块对退化拓扑
 * （悬挂边 / 源非文字）做确定性降级，绝不抛错。
 *
 * @module lib/canvas/annotation
 */

import { MarkerType, type EdgeMarker } from '@xyflow/react';
import type { CanvasFlowEdge, CanvasFlowNode } from './node-mapper';

/** 描述边的类型标识，与 {@link types/edges}.EDGE_TYPES 一致。 */
export const ANNOTATION_EDGE_TYPE = 'annotation' as const;

/** 文字节点「描述出桩」的 handle id（写入 `canvas_edges.source_handle`）。 */
export const ANNOTATION_HANDLE_OUT = 'annotation-out';

/** 描述边末端箭头（指向被描述的图，弱化的中性色）。 */
export const ANNOTATION_MARKER_END: EdgeMarker = {
  type: MarkerType.Arrow,
  width: 14,
  height: 14,
  color: 'hsl(var(--muted-foreground))',
};

/**
 * 为描述边附加渲染装饰：类型与末端箭头（虚线样式由 {@link components/canvas/edges/AnnotationEdge}
 * 渲染，装饰字段不参与持久化，见 {@link lib/canvas/node-mapper}.edgeToInsert）。
 *
 * @param edge - 基础边（至少含 id / source / target）
 * @returns 带装饰的描述边
 */
export function decorateAnnotationEdge(edge: CanvasFlowEdge): CanvasFlowEdge {
  return {
    ...edge,
    type: ANNOTATION_EDGE_TYPE,
    animated: false,
    markerEnd: ANNOTATION_MARKER_END,
  };
}

/** 仅取 `annotation` 类型的边。 */
function annotationEdges(edges: CanvasFlowEdge[]): CanvasFlowEdge[] {
  return edges.filter((e) => e.type === ANNOTATION_EDGE_TYPE);
}

/** 节点是否可作为描述来源（仅文字节点）。 */
export function isAnnotationSource(node: CanvasFlowNode): boolean {
  return node.data.type === 'text';
}

/**
 * 取连到某图片 / 视频节点的描述文本（其描述边源端文字节点的内容，去除首尾空白）。
 * 无描述、源非文字或文本为空时返回 null。
 *
 * @param nodes - 当前全部节点
 * @param edges - 当前全部边
 * @param targetId - 被描述的图片 / 视频节点 id
 * @returns 描述文本或 null
 */
export function getImageDescription(
  nodes: CanvasFlowNode[],
  edges: CanvasFlowEdge[],
  targetId: string,
): string | null {
  const edge = annotationEdges(edges).find((e) => e.target === targetId);
  if (!edge) return null;
  const note = nodes.find((n) => n.id === edge.source);
  if (!note || note.data.type !== 'text') return null;
  const text = note.data.text.trim();
  return text.length > 0 ? text : null;
}

/**
 * 判定文字节点是否已作为某图的描述（任一描述边的源端）。
 *
 * @param edges - 当前全部边
 * @param noteId - 文字节点 id
 * @returns 是否为描述边源端
 */
export function isDescribingNote(edges: CanvasFlowEdge[], noteId: string): boolean {
  return annotationEdges(edges).some((e) => e.source === noteId);
}
