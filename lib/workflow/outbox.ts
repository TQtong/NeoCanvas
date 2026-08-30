'use client';

/** Flow 编辑离线 Outbox：每个 workflow 保存最后一份增量快照。 */

import type { WorkflowGraphEdge, WorkflowGraphNode } from '@/types';

export interface WorkflowMutationBatch {
  workflowId: string;
  nodes: WorkflowGraphNode[];
  edges: WorkflowGraphEdge[];
  deletedNodeIds: string[];
  deletedEdgeIds: string[];
  queuedAt: string;
}

const DATABASE = 'neocanvas-flow-outbox';
const STORE = 'mutations';

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE, { keyPath: 'workflowId' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transaction<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  const database = await openDatabase();
  if (!database) return null;
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE, mode);
    const request = action(tx.objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => database.close();
    tx.onerror = () => reject(tx.error);
  });
}

export async function putWorkflowOutbox(batch: WorkflowMutationBatch): Promise<void> {
  await transaction('readwrite', (store) => store.put(batch));
}

export async function readWorkflowOutbox(
  workflowId: string,
): Promise<WorkflowMutationBatch | null> {
  return (await transaction('readonly', (store) =>
    store.get(workflowId),
  )) as WorkflowMutationBatch | null;
}

export async function deleteWorkflowOutbox(workflowId: string): Promise<void> {
  await transaction('readwrite', (store) => store.delete(workflowId));
}
