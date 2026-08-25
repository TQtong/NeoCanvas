import { describe, expect, it } from 'vitest';
import {
  resolveSequenceChain,
  SEQUENCE_EDGE_TYPE,
  sequenceOrderIndex,
  wouldCreateSequenceCycle,
} from '@/lib/canvas/sequence';
import type { CanvasFlowEdge } from '@/lib/canvas/node-mapper';
import { canvasNode } from '../fixtures';

const edge = (id: string, source: string, target: string): CanvasFlowEdge => ({
  id,
  source,
  target,
  type: SEQUENCE_EDGE_TYPE,
});

describe('生成血缘序列 DAG', () => {
  it('多分支选择经过成员的最长路径，等长时按空间顺序稳定选择', () => {
    const nodes = [
      canvasNode('a', 'image', { position_x: 0 }),
      canvasNode('b', 'image', { position_x: 100 }),
      canvasNode('c', 'image', { position_x: 100, position_y: 100 }),
      canvasNode('d', 'video', { position_x: 200 }),
    ];
    const edges = [edge('ab', 'a', 'b'), edge('ac', 'a', 'c'), edge('bd', 'b', 'd')];
    expect(resolveSequenceChain(nodes, edges, 'a').nodes.map((node) => node.id)).toEqual([
      'a',
      'b',
      'd',
    ]);
    expect(sequenceOrderIndex(nodes, edges, 'd')).toBe(2);
  });

  it('拒绝自环和任何可达回边', () => {
    const edges = [edge('ab', 'a', 'b'), edge('bc', 'b', 'c')];
    expect(wouldCreateSequenceCycle(edges, 'c', 'a')).toBe(true);
    expect(wouldCreateSequenceCycle(edges, 'a', 'a')).toBe(true);
    expect(wouldCreateSequenceCycle(edges, 'a', 'd')).toBe(false);
  });

  it('异常实时环不会造成递归死循环并显式标记', () => {
    const nodes = [canvasNode('a', 'image'), canvasNode('b', 'image')];
    const chain = resolveSequenceChain(nodes, [edge('ab', 'a', 'b'), edge('ba', 'b', 'a')], 'a');
    expect(chain.hasCycle).toBe(true);
    expect(new Set(chain.nodes.map((node) => node.id))).toEqual(new Set(['a', 'b']));
  });
});
