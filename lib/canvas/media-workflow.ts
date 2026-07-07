import type { NodeDataOf, NodeType } from '@/types';
import { createDefaultNodeData, DEFAULT_NODE_SIZE } from '@/lib/canvas/constants';
import type { CanvasFlowNode } from '@/lib/canvas/node-mapper';
import { nodeBox } from '@/lib/canvas/node-mapper';
import { uuid } from '@/lib/utils/id';

export interface FlowPoint {
  x: number;
  y: number;
}

export interface FlowSize {
  width: number;
  height: number;
}

const MEDIA_PANEL_GAP = 24;
const CANDIDATE_HORIZONTAL_GAP_MIN = 280;
const CANDIDATE_HORIZONTAL_GAP_RATIO = 1;
const CANDIDATE_BRANCH_X_STEP_MIN = 88;
const CANDIDATE_BRANCH_X_STEP_RATIO = 0.28;
const CANDIDATE_COLUMN_GAP_MIN = 144;
const CANDIDATE_COLUMN_GAP_RATIO = 0.45;
const CANDIDATE_BRANCH_GAP_MIN = 96;
const CANDIDATE_BRANCH_GAP_RATIO = 0.35;
const CANDIDATE_CENTER_CORRIDOR_ROWS = 0.75;
const CANDIDATE_SLOTS_PER_COLUMN = 4;

export function createCanvasNode<T extends NodeType>(
  type: T,
  position: FlowPoint,
  options: {
    id?: string;
    size?: FlowSize;
    data?: Partial<NodeDataOf<T>>;
    zIndex?: number;
  } = {},
): CanvasFlowNode {
  const size = options.size ?? DEFAULT_NODE_SIZE[type];
  return {
    id: options.id ?? uuid(),
    type,
    position,
    data: createDefaultNodeData(type, options.data),
    width: size.width,
    height: size.height,
    zIndex: options.zIndex ?? 0,
    style: { width: size.width, height: size.height },
  };
}

export function createMediaTargetWithPanelNodes(options: {
  modality: 'image' | 'video';
  position: FlowPoint;
  size?: FlowSize;
  mediaData?: Partial<NodeDataOf<'image'>> | Partial<NodeDataOf<'video'>>;
  zIndex?: number;
}): { target: CanvasFlowNode; panel: CanvasFlowNode } {
  const size = options.size ?? DEFAULT_NODE_SIZE[options.modality];
  const targetId = uuid();
  const zIndex = options.zIndex ?? 0;
  const target =
    options.modality === 'video'
      ? createCanvasNode('video', options.position, {
          id: targetId,
          size,
          zIndex,
          data: options.mediaData as Partial<NodeDataOf<'video'>>,
        })
      : createCanvasNode('image', options.position, {
          id: targetId,
          size,
          zIndex,
          data: options.mediaData as Partial<NodeDataOf<'image'>>,
        });

  const panel = createCanvasNode(
    'media_panel',
    { x: options.position.x, y: options.position.y + size.height + MEDIA_PANEL_GAP },
    {
      size: { width: size.width, height: DEFAULT_NODE_SIZE.media_panel.height },
      zIndex: zIndex + 1,
      data: { targetNodeId: targetId },
    },
  );

  return { target, panel };
}

export function candidatePlacementForTarget(
  target: CanvasFlowNode,
  index: number,
): FlowPoint & FlowSize & { parentId: string | null } {
  const box = nodeBox(target);
  const horizontalGap = Math.max(
    CANDIDATE_HORIZONTAL_GAP_MIN,
    Math.round(box.width * CANDIDATE_HORIZONTAL_GAP_RATIO),
  );
  const verticalStep =
    box.height +
    MEDIA_PANEL_GAP +
    DEFAULT_NODE_SIZE.media_panel.height +
    Math.max(CANDIDATE_BRANCH_GAP_MIN, Math.round(box.height * CANDIDATE_BRANCH_GAP_RATIO));
  const rowOffset = candidateBranchRowOffset(index);
  const column = candidateBranchColumn(index);
  const branchXStep = Math.max(
    CANDIDATE_BRANCH_X_STEP_MIN,
    Math.round(box.width * CANDIDATE_BRANCH_X_STEP_RATIO),
  );
  const columnGap = Math.max(
    CANDIDATE_COLUMN_GAP_MIN,
    Math.round(box.width * CANDIDATE_COLUMN_GAP_RATIO),
  );
  return {
    x:
      box.x +
      box.width +
      horizontalGap +
      column * (box.width + columnGap) +
      Math.abs(rowOffset) * branchXStep,
    y: box.y + rowOffset * verticalStep,
    width: box.width,
    height: box.height,
    parentId: target.parentId ?? null,
  };
}

/** 候选按树状分叉排布，并始终避开主路线所在的中心走廊。 */
function candidateBranchRowOffset(index: number): number {
  const safeIndex = Math.max(0, Math.floor(index));
  const columnIndex = safeIndex % CANDIDATE_SLOTS_PER_COLUMN;
  const pairIndex = Math.floor(columnIndex / 2);
  const distance = pairIndex + CANDIDATE_CENTER_CORRIDOR_ROWS;
  return columnIndex % 2 === 0 ? -distance : distance;
}

/** 每列放固定数量候选，放满后向右开新列，避免无限向上/下延伸。 */
function candidateBranchColumn(index: number): number {
  const safeIndex = Math.max(0, Math.floor(index));
  return Math.floor(safeIndex / CANDIDATE_SLOTS_PER_COLUMN);
}
