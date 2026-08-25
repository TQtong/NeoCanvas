import { describe, expect, it } from 'vitest';
import {
  countProjectOutbox,
  deleteConfirmedOutboxEntry,
  listProjectOutbox,
  putOutboxEntry,
  type OutboxEntry,
} from '@/lib/canvas/outbox';

let namespace = 0;

function entry(
  projectId: string,
  entityId: string,
  clientRevision: number,
  operation: OutboxEntry['operation'] = 'upsert',
): OutboxEntry {
  return {
    projectId,
    entity: 'node',
    entityId,
    operation,
    payload: { revision: clientRevision },
    clientRevision,
    createdAt: '2026-08-25T08:00:00Z',
    updatedAt: `2026-08-25T08:00:${String(clientRevision).padStart(2, '0')}Z`,
  };
}

describe('IndexedDB 画布 outbox', () => {
  it('同一实体只保留最新 revision，删除可覆盖更早 upsert', async () => {
    const projectId = `outbox-project-${namespace++}`;
    await putOutboxEntry(entry(projectId, 'node-1', 2));
    await putOutboxEntry(entry(projectId, 'node-1', 1));
    await putOutboxEntry(entry(projectId, 'node-1', 3, 'delete'));

    expect(await listProjectOutbox(projectId)).toEqual([
      expect.objectContaining({ entityId: 'node-1', clientRevision: 3, operation: 'delete' }),
    ]);
    expect(await countProjectOutbox(projectId)).toBe(1);
  });

  it('慢速旧请求的确认不能删除等待中的新版本', async () => {
    const projectId = `outbox-project-${namespace++}`;
    await putOutboxEntry(entry(projectId, 'node-1', 10));
    await deleteConfirmedOutboxEntry(projectId, 'node', 'node-1', 9);
    expect(await countProjectOutbox(projectId)).toBe(1);

    await deleteConfirmedOutboxEntry(projectId, 'node', 'node-1', 10);
    expect(await countProjectOutbox(projectId)).toBe(0);
  });

  it('项目隔离且按 revision 稳定排序', async () => {
    const projectId = `outbox-project-${namespace++}`;
    const otherProject = `outbox-project-${namespace++}`;
    await putOutboxEntry(entry(projectId, 'node-b', 7));
    await putOutboxEntry(entry(projectId, 'node-a', 4));
    await putOutboxEntry(entry(otherProject, 'node-x', 1));

    expect((await listProjectOutbox(projectId)).map((item) => item.clientRevision)).toEqual([4, 7]);
    expect(await countProjectOutbox(otherProject)).toBe(1);
  });
});
