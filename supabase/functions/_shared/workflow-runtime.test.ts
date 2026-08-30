import { assertEquals } from 'jsr:@std/assert@1';
import type { WorkflowGraph } from './types.ts';
import {
  applyWorkflowPatch,
  forceRerunWorkflowNodeIds,
  normalizeWorkflowPatchOperations,
  plannedWorkflowNodeIds,
  validateExecutableWorkflowGraph,
} from './workflow-runtime.ts';

const graph: WorkflowGraph = {
  nodes: [
    {
      id: 'a',
      kind: 'text_input',
      position: { x: 0, y: 0 },
      config: { value: 'x' },
      schemaVersion: 1,
    },
    {
      id: 'b',
      kind: 'prompt_template',
      position: { x: 200, y: 0 },
      config: { template: '{{variables}}' },
      schemaVersion: 1,
    },
    {
      id: 'c',
      kind: 'image_generate',
      position: { x: 400, y: 0 },
      config: { modelKey: 'image-model', count: 1, aspectRatio: '1:1' },
      schemaVersion: 1,
    },
  ],
  edges: [
    {
      id: 'ab',
      sourceNodeId: 'a',
      sourcePort: 'text',
      targetNodeId: 'b',
      targetPort: 'variables',
      valueType: 'text',
    },
    {
      id: 'bc',
      sourceNodeId: 'b',
      sourcePort: 'text',
      targetNodeId: 'c',
      targetPort: 'prompt',
      valueType: 'text',
    },
  ],
};

Deno.test('workflow runtime plans ancestors and descendants', () => {
  assertEquals(new Set(plannedWorkflowNodeIds(graph, 'node', 'c')), new Set(['a', 'b', 'c']));
  assertEquals(new Set(plannedWorkflowNodeIds(graph, 'downstream', 'b')), new Set(['a', 'b', 'c']));
  assertEquals(validateExecutableWorkflowGraph(graph), []);
});

Deno.test('force rerun bypasses only the target and downstream, not required ancestors', () => {
  const edges = graph.edges.map((edge) => ({
    source_node_id: edge.sourceNodeId,
    target_node_id: edge.targetNodeId,
  }));
  assertEquals(
    forceRerunWorkflowNodeIds(['a', 'b', 'c'], edges, 'downstream', 'b', true),
    new Set(['b', 'c']),
  );
  assertEquals(
    forceRerunWorkflowNodeIds(['a', 'b', 'c'], edges, 'node', 'c', true),
    new Set(['c']),
  );
  assertEquals(
    forceRerunWorkflowNodeIds(['a', 'b', 'c'], edges, 'all', null, false),
    new Set(),
  );
});

Deno.test('workflow patch is applied to a copy and revalidated', () => {
  const candidate = applyWorkflowPatch(graph, [{
    op: 'add_edge',
    edge: {
      id: 'cycle',
      sourceNodeId: 'c',
      sourcePort: 'images',
      targetNodeId: 'b',
      targetPort: 'variables',
      valueType: 'image_list',
    },
  }]);
  assertEquals(graph.edges.length, 2);
  const codes = validateExecutableWorkflowGraph(candidate).map((problem) => problem.code);
  assertEquals(codes.includes('type_mismatch'), true);
  assertEquals(codes.includes('cycle'), true);
});

Deno.test('agent temporary IDs are remapped together with edge references', () => {
  const ids = [
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002',
  ];
  const operations = normalizeWorkflowPatchOperations(
    [
      {
        op: 'add_node',
        node: {
          id: 'new-output',
          kind: 'text_output',
          position: { x: 600, y: 0 },
          config: {},
          schemaVersion: 1,
        },
      },
      {
        op: 'add_edge',
        edge: {
          id: 'new-edge',
          sourceNodeId: 'a',
          sourcePort: 'text',
          targetNodeId: 'new-output',
          targetPort: 'text',
          valueType: 'text',
        },
      },
    ],
    graph,
    () => ids.shift()!,
  );
  assertEquals(
    operations[0]?.op === 'add_node' ? operations[0].node.id : null,
    '10000000-0000-4000-8000-000000000001',
  );
  assertEquals(
    operations[1]?.op === 'add_edge' ? operations[1].edge.targetNodeId : null,
    '10000000-0000-4000-8000-000000000001',
  );
  assertEquals(
    operations[1]?.op === 'add_edge' ? operations[1].edge.id : null,
    '10000000-0000-4000-8000-000000000002',
  );
});

Deno.test('server validates and plans a 500-node 1000-edge DAG under 100ms', () => {
  const inputs = Array.from({ length: 250 }, (_, index) => ({
    id: `input-${index}`,
    kind: 'text_input' as const,
    position: { x: 0, y: index * 20 },
    config: { value: `input-${index}` },
    schemaVersion: 1,
  }));
  const templates = Array.from({ length: 250 }, (_, index) => ({
    id: `template-${index}`,
    kind: 'prompt_template' as const,
    position: { x: 360, y: index * 20 },
    config: { template: '{{variables}}' },
    schemaVersion: 1,
  }));
  const largeGraph: WorkflowGraph = {
    nodes: [...inputs, ...templates],
    edges: templates.flatMap((target, targetIndex) =>
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
      })
    ),
  };
  const startedAt = performance.now();
  assertEquals(validateExecutableWorkflowGraph(largeGraph), []);
  assertEquals(plannedWorkflowNodeIds(largeGraph, 'all').length, 500);
  const elapsed = performance.now() - startedAt;
  if (elapsed >= 100) throw new Error(`server graph plan exceeded 100ms: ${elapsed.toFixed(2)}ms`);
});
