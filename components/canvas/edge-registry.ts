/**
 * React Flow 边类型注册（第 04 篇画布连线）。
 *
 * 把本产品的自定义边类型与组件对应。键与 {@link types/edges}.EDGE_TYPES、
 * {@link lib/canvas/sequence}.SEQUENCE_EDGE_TYPE 一致；未列出的类型（default / lineage）
 * 走 React Flow 内置渲染。
 *
 * @module components/canvas/edge-registry
 */

import type { EdgeTypes } from '@xyflow/react';
import { SequenceEdge } from './edges/SequenceEdge';
import { AnnotationEdge } from './edges/AnnotationEdge';

/** 边类型注册表，传入 ReactFlow 的 edgeTypes。 */
export const edgeTypes: EdgeTypes = {
  sequence: SequenceEdge,
  annotation: AnnotationEdge,
};
