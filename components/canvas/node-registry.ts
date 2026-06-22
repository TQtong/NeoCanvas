/**
 * React Flow 节点类型注册（第 04 篇 4.4）。
 *
 * 通过 nodeTypes 把本产品的全部节点类型与自定义组件一一对应，键与 `node_type` 枚举、
 * 数据库 `canvas_nodes.type`、映射器三者一致。
 *
 * @module components/canvas/node-registry
 */

import type { NodeTypes } from '@xyflow/react';
import { ImageNode } from './nodes/ImageNode';
import { TextNode } from './nodes/TextNode';
import { ShapeNode } from './nodes/ShapeNode';
import { DrawingNode } from './nodes/DrawingNode';
import { VideoNode } from './nodes/VideoNode';
import { GenerationPlaceholderNode } from './nodes/GenerationPlaceholderNode';
import { FrameNode } from './nodes/FrameNode';

/** 节点类型注册表，传入 ReactFlow 的 nodeTypes。 */
export const nodeTypes: NodeTypes = {
  image: ImageNode,
  text: TextNode,
  shape: ShapeNode,
  drawing: DrawingNode,
  video: VideoNode,
  generation_placeholder: GenerationPlaceholderNode,
  frame: FrameNode,
};
