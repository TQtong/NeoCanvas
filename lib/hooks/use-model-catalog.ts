'use client';

/**
 * 模型目录钩子。优先使用服务端预取的目录，必要时客户端兜底拉取。
 *
 * @module lib/hooks/use-model-catalog
 */

import { useEffect, useState } from 'react';
import type { ModelCatalogEntry } from '@/types';
import { getBrowserSupabase } from '@/lib/supabase/client';
import { fetchModelCatalog } from '@/lib/models/catalog';

/**
 * 模型目录钩子。
 *
 * @param initial - 服务端预取的目录（水合）
 * @returns 模型条目数组
 */
export function useModelCatalog(initial: ModelCatalogEntry[] = []): ModelCatalogEntry[] {
  const [models, setModels] = useState<ModelCatalogEntry[]>(initial);

  useEffect(() => {
    if (initial.length > 0) return;
    let active = true;
    void fetchModelCatalog(getBrowserSupabase()).then((entries) => {
      if (active) setModels(entries);
    });
    return () => {
      active = false;
    };
  }, [initial.length]);

  return models;
}
