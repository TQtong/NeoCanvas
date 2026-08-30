import { describe, expect, it } from 'vitest';
import type { WorkflowGraph } from '@/types';
import { topologicalWorkflowNodeIds, workflowDescendants } from '@/types';
import { createWorkflowGraphNode, validateWorkflowGraph } from '@/lib/workflow/registry';

describe('workflow graph', () => {
  it('校验强类型端口并给出稳定拓扑序', () => {
    const input = createWorkflowGraphNode('text_input', { x: 0, y: 0 });
    const output = createWorkflowGraphNode('text_output', { x: 300, y: 0 });
    const graph: WorkflowGraph = {
      nodes: [input, output],
      edges: [
        {
          id: 'edge-a',
          sourceNodeId: input.id,
          sourcePort: 'text',
          targetNodeId: output.id,
          targetPort: 'text',
          valueType: 'text',
        },
      ],
    };

    expect(validateWorkflowGraph(graph)).toEqual([]);
    expect(topologicalWorkflowNodeIds(graph)).toEqual([input.id, output.id]);
    expect(workflowDescendants(graph, [input.id])).toEqual(new Set([input.id, output.id]));
  });

  it('拒绝端口类型不匹配、重复单输入和环路', () => {
    const image = createWorkflowGraphNode('image_input', { x: 0, y: 0 });
    const image2 = createWorkflowGraphNode('image_input', { x: 0, y: 100 });
    const output = createWorkflowGraphNode('text_output', { x: 300, y: 0 });
    const graph: WorkflowGraph = {
      nodes: [image, image2, output],
      edges: [image, image2].map((node, index) => ({
        id: `edge-${index}`,
        sourceNodeId: node.id,
        sourcePort: 'image',
        targetNodeId: output.id,
        targetPort: 'text',
        valueType: 'image_asset' as const,
      })),
    };
    const codes = validateWorkflowGraph(graph).map((problem) => problem.code);
    expect(codes).toContain('type_mismatch');
    expect(codes).toContain('duplicate_input');

    const cyclic: WorkflowGraph = {
      nodes: [
        { ...output, id: 'a' },
        { ...output, id: 'b' },
      ],
      edges: [
        {
          id: 'ab',
          sourceNodeId: 'a',
          sourcePort: 'text',
          targetNodeId: 'b',
          targetPort: 'text',
          valueType: 'text',
        },
        {
          id: 'ba',
          sourceNodeId: 'b',
          sourcePort: 'text',
          targetNodeId: 'a',
          targetPort: 'text',
          valueType: 'text',
        },
      ],
    };
    expect(validateWorkflowGraph(cyclic).map((problem) => problem.code)).toContain('cycle');
  });

  it('在 500 节点和 1000 边规模保持确定性', () => {
    const inputs = Array.from({ length: 250 }, (_, index) => ({
      ...createWorkflowGraphNode('text_input', { x: 0, y: index * 20 }),
      id: `input-${index.toString().padStart(3, '0')}`,
    }));
    const templates = Array.from({ length: 250 }, (_, index) => ({
      ...createWorkflowGraphNode('prompt_template', { x: 360, y: index * 20 }),
      id: `template-${index.toString().padStart(3, '0')}`,
    }));
    const nodes = [...inputs, ...templates];
    const edges = templates.flatMap((target, targetIndex) =>
      Array.from({ length: 4 }, (_, offset) => {
        const source = inputs[(targetIndex * 4 + offset) % inputs.length]!;
        return {
          id: `edge-${targetIndex}-${offset}`,
          sourceNodeId: source.id,
          sourcePort: 'text',
          targetNodeId: target.id,
          targetPort: 'variables',
          valueType: 'text' as const,
        };
      }),
    );
    const graph = { nodes, edges };
    const startedAt = performance.now();
    expect(validateWorkflowGraph(graph)).toEqual([]);
    expect(topologicalWorkflowNodeIds(graph)).toHaveLength(500);
    expect(performance.now() - startedAt).toBeLessThan(100);
  });
});
