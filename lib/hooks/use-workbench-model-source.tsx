'use client';

/**
 * 设计工作台共享模型与凭据数据源。
 *
 * 工作台只挂载一个目录查询和一个脱敏凭据查询，所有 ChatPanel、工具栏和 MediaPanelNode 通过
 * Context 消费同一快照。凭据或模型目录事件触发源级刷新，不随画布节点数量增加请求。
 *
 * @module lib/hooks/use-workbench-model-source
 */

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { ModelCatalogEntry, ProviderCredential } from '@/types';
import { useModelCatalog } from '@/lib/hooks/use-model-catalog';
import { useProviderCredentials } from '@/lib/hooks/use-provider-credentials';

/** 工作台共享只读数据。 */
export interface WorkbenchModelSource {
  models: ModelCatalogEntry[];
  credentials: ProviderCredential[];
  credentialsLoading: boolean;
  refreshCredentials: () => Promise<void>;
}

const WorkbenchModelContext = createContext<WorkbenchModelSource | null>(null);

/** 共享模型数据源 Provider 属性。 */
export interface WorkbenchModelProviderProps {
  initialModels: ModelCatalogEntry[];
  children: ReactNode;
}

/** 在工作台根部挂载唯一的模型与凭据查询。 */
export function WorkbenchModelProvider({ initialModels, children }: WorkbenchModelProviderProps) {
  const models = useModelCatalog(initialModels);
  const credentialsApi = useProviderCredentials();
  const value = useMemo<WorkbenchModelSource>(
    () => ({
      models,
      credentials: credentialsApi.credentials,
      credentialsLoading: credentialsApi.loading,
      refreshCredentials: credentialsApi.refresh,
    }),
    [credentialsApi.credentials, credentialsApi.loading, credentialsApi.refresh, models],
  );
  return <WorkbenchModelContext.Provider value={value}>{children}</WorkbenchModelContext.Provider>;
}

/** 读取工作台共享模型源；在 Provider 外调用属于装配错误。 */
export function useWorkbenchModelSource(): WorkbenchModelSource {
  const value = useContext(WorkbenchModelContext);
  if (!value) throw new Error('useWorkbenchModelSource 必须在 WorkbenchModelProvider 内使用');
  return value;
}
