import { describe, expect, it } from 'vitest';
import { NODE_TYPES } from '@/types';
import {
  edgeToInsert,
  nodeDataToColumn,
  nodeToColumns,
  rowToEdge,
  rowToNode,
} from '@/lib/canvas/node-mapper';
import { canvasNodeRow } from '../fixtures';

describe('画布行与节点映射', () => {
  it.each(NODE_TYPES)('%s 节点在行 → 节点 → 列往返中保留持久字段', (type) => {
    const row = canvasNodeRow(`node-${type}`, type, {
      position_x: 123.5,
      position_y: -45.25,
      rotation: 27,
      z_index: -3,
      parent_id: 'frame-1',
    });
    const node = rowToNode(row);
    const columns = nodeToColumns(node);

    expect(node.position).toEqual({ x: 123.5, y: -45.25 });
    expect(node.zIndex).toBe(0);
    expect(node.parentId).toBe('frame-1');
    expect(columns.type).toBe(type);
    expect(columns.rotation).toBe(27);
    expect(columns.z_index).toBe(0);
    expect(columns.parent_id).toBe('frame-1');
  });

  it('运行时 URL、进度和桥接字段绝不写入 data JSONB', () => {
    const data = {
      ...rowToNode(canvasNodeRow('image-1', 'image')).data,
      src: 'signed-url',
      thumbnailSrc: 'thumb-url',
      urlExpiresAt: '2026-08-25T09:00:00Z',
    };
    expect(nodeDataToColumn(data)).not.toHaveProperty('src');
    expect(nodeDataToColumn(data)).not.toHaveProperty('thumbnailSrc');
    expect(nodeDataToColumn(data)).not.toHaveProperty('urlExpiresAt');
    expect(nodeDataToColumn(data)).not.toHaveProperty('type');
    expect(nodeDataToColumn(data)).not.toHaveProperty('rotation');
  });

  it('序列边加载时恢复动画和箭头，写回时只保留数据库列', () => {
    const row = {
      id: 'edge-1',
      project_id: 'project-1',
      source_node_id: 'a',
      target_node_id: 'b',
      source_handle: 'seq-out',
      target_handle: 'seq-in',
      type: 'sequence',
      data: {},
      created_at: '2026-08-25T08:00:00Z',
    };
    const edge = rowToEdge(row);
    expect(edge.animated).toBe(true);
    expect(edge.markerEnd).toBeDefined();
    expect(edgeToInsert(edge, 'project-1')).toMatchObject({
      id: 'edge-1',
      source_node_id: 'a',
      target_node_id: 'b',
      type: 'sequence',
    });
  });
});
