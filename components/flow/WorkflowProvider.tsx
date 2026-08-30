'use client';

/** Flow Store 的 React 实例边界。 */

import { createContext, useContext, useRef, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { createWorkflowStore, type WorkflowState } from '@/stores/workflow-store';

const WorkflowStoreContext = createContext<ReturnType<typeof createWorkflowStore> | null>(null);

export function WorkflowProvider({
  workflowId,
  children,
}: {
  workflowId: string;
  children: ReactNode;
}) {
  const storeRef = useRef<ReturnType<typeof createWorkflowStore> | null>(null);
  if (!storeRef.current) storeRef.current = createWorkflowStore(workflowId);
  return (
    <WorkflowStoreContext.Provider value={storeRef.current}>
      {children}
    </WorkflowStoreContext.Provider>
  );
}

export function useWorkflowStore<T>(selector: (state: WorkflowState) => T): T {
  const store = useContext(WorkflowStoreContext);
  if (!store) throw new Error('useWorkflowStore 必须位于 WorkflowProvider 内');
  return useStore(store, selector);
}

export function useWorkflowStoreApi(): ReturnType<typeof createWorkflowStore> {
  const store = useContext(WorkflowStoreContext);
  if (!store) throw new Error('useWorkflowStoreApi 必须位于 WorkflowProvider 内');
  return store;
}
