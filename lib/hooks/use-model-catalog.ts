'use client';

/**
 * 模型目录钩子。优先使用服务端预取的目录，并在提供商凭据变化时重新拉取。
 *
 * @module lib/hooks/use-model-catalog
 */

import { useEffect, useState } from 'react';
import type { ModelCatalogEntry } from '@/types';
import { getBrowserSupabase } from '@/lib/supabase/client';
import { fetchModelCatalog } from '@/lib/models/catalog';
import { PROVIDER_CREDENTIALS_CHANGED_EVENT } from '@/lib/hooks/use-provider-credentials';

/**
 * 模型目录钩子。
 *
 * @param initial - 服务端预取的目录（水合）
 * @returns 模型条目数组
 */
export function useModelCatalog(initial: ModelCatalogEntry[] = []): ModelCatalogEntry[] {
  const [models, setModels] = useState<ModelCatalogEntry[]>(initial);

  useEffect(() => {
    let active = true;

    // 凭据保存、启停或删除后重新拉取，保证全部选择器只展示当前真正可调用的提供商模型。
    const loadCatalog = async (): Promise<void> => {
      const entries = await fetchModelCatalog(getBrowserSupabase());
      if (active) setModels(entries);
    };

    const onProviderCredentialsChanged = (): void => {
      void loadCatalog();
    };

    // 服务端没有可用模型时在客户端再确认一次，以覆盖登录态刚建立时的短暂空快照。
    if (initial.length === 0) void loadCatalog();
    window.addEventListener(PROVIDER_CREDENTIALS_CHANGED_EVENT, onProviderCredentialsChanged);
    return () => {
      active = false;
      window.removeEventListener(PROVIDER_CREDENTIALS_CHANGED_EVENT, onProviderCredentialsChanged);
    };
  }, [initial.length]);

  return models;
}
