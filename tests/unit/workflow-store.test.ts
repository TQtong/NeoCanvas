import { describe, expect, it } from 'vitest';
import { createWorkflowStore } from '@/stores/workflow-store';
import { createWorkflowGraphNode } from '@/lib/workflow/registry';

describe('workflow store', () => {
  it('配置变化只标记当前节点及下游 stale，不触发运行', () => {
    const store = createWorkflowStore('workflow-a');
    const input = createWorkflowGraphNode('text_input', { x: 0, y: 0 });
    const output = createWorkflowGraphNode('text_output', { x: 300, y: 0 });
    store.getState().addNode(input);
    store.getState().addNode(output);
    expect(
      store.getState().addEdge({
        id: 'edge-a',
        sourceNodeId: input.id,
        sourcePort: 'text',
        targetNodeId: output.id,
        targetPort: 'text',
        valueType: 'text',
      }),
    ).toBe(true);

    store.getState().updateNodeConfig(input.id, { value: '新提示词' });
    expect(store.getState().staleNodeIds).toEqual(new Set([input.id, output.id]));
    expect(store.getState().runs).toEqual([]);
    expect(store.getState().dirtyNodeIds.has(input.id)).toBe(true);
  });

  it('拒绝类型不匹配与环路连接', () => {
    const store = createWorkflowStore('workflow-b');
    const first = createWorkflowGraphNode('text_output', { x: 0, y: 0 });
    const second = createWorkflowGraphNode('text_output', { x: 300, y: 0 });
    store.getState().addNode(first);
    store.getState().addNode(second);
    expect(
      store.getState().addEdge({
        id: 'first-second',
        sourceNodeId: first.id,
        sourcePort: 'text',
        targetNodeId: second.id,
        targetPort: 'text',
        valueType: 'text',
      }),
    ).toBe(true);
    expect(
      store.getState().addEdge({
        id: 'second-first',
        sourceNodeId: second.id,
        sourcePort: 'text',
        targetNodeId: first.id,
        targetPort: 'text',
        valueType: 'text',
      }),
    ).toBe(false);
  });

  it('仅在 flush epoch 未变化时清空 dirty 集合', () => {
    const store = createWorkflowStore('workflow-c');
    const node = createWorkflowGraphNode('note', { x: 0, y: 0 });
    store.getState().addNode(node);
    const firstEpoch = store.getState().changeEpoch;
    store.getState().updateNodePosition(node.id, { x: 10, y: 20 });
    store.getState().clearDirty(firstEpoch, 2);
    expect(store.getState().dirtyNodeIds.has(node.id)).toBe(true);
    store.getState().clearDirty(store.getState().changeEpoch, 3);
    expect(store.getState().dirtyNodeIds.size).toBe(0);
    expect(store.getState().graphRevision).toBe(3);
  });
});
