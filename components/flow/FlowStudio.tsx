'use client';

/** 项目内 Flow Studio 容器：工作流选择、创建与实例级编辑器。 */

import { useCallback, useEffect, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { AppWindow, ChevronDown, Plus, Workflow } from 'lucide-react';
import type { AssetRow, ModelCatalogEntry, WorkflowRow } from '@/types';
import { getBrowserSupabase } from '@/lib/supabase/client';
import { WorkflowProvider } from '@/components/flow/WorkflowProvider';
import { FlowEditor } from '@/components/flow/FlowEditor';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useToast } from '@/components/ui/toast';
import { FlowAppLauncher } from '@/components/flow/FlowAppLauncher';

export interface FlowStudioProps {
  projectId: string;
  userId: string;
  models: ModelCatalogEntry[];
}

export function FlowStudio({ projectId, userId, models }: FlowStudioProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const toast = useToast();
  const [workflows, setWorkflows] = useState<WorkflowRow[]>([]);
  const [assets, setAssets] = useState<AssetRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [appsOpen, setAppsOpen] = useState(false);
  const requestedId = searchParams.get('workflow');
  const selected =
    workflows.find((workflow) => workflow.id === requestedId) ?? workflows[0] ?? null;

  const navigate = useCallback(
    (workflowId: string) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set('view', 'flow');
      params.set('workflow', workflowId);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  const createWorkflow = useCallback(
    async (name?: string) => {
      setCreating(true);
      try {
        const { data, error } = await getBrowserSupabase()
          .from('workflows')
          .insert({
            project_id: projectId,
            owner_id: userId,
            name: name ?? `工作流 ${workflows.length + 1}`,
          })
          .select('*')
          .single();
        if (error || !data) throw error ?? new Error('创建工作流失败');
        setWorkflows((current) => [...current, data]);
        navigate(data.id);
        return data;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : '创建工作流失败');
        return null;
      } finally {
        setCreating(false);
      }
    },
    [navigate, projectId, toast, userId, workflows.length],
  );

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      getBrowserSupabase()
        .from('workflows')
        .select('*')
        .eq('project_id', projectId)
        .order('created_at'),
      getBrowserSupabase()
        .from('assets')
        .select('*')
        .eq('project_id', projectId)
        .order('created_at', { ascending: false }),
    ])
      .then(async ([workflowResult, assetResult]) => {
        if (cancelled) return;
        let rows = (workflowResult.data ?? []) as WorkflowRow[];
        setAssets((assetResult.data ?? []) as AssetRow[]);
        if (rows.length === 0) {
          const { data, error } = await getBrowserSupabase()
            .from('workflows')
            .insert({
              project_id: projectId,
              owner_id: userId,
              name: '主工作流',
            })
            .select('*')
            .single();
          if (!error && data) rows = [data];
        }
        if (cancelled) return;
        setWorkflows(rows);
        setLoading(false);
        const requestedExists = rows.some((workflow) => workflow.id === requestedId);
        if (rows[0] && !requestedExists) navigate(rows[0].id);
      })
      .catch((error) => {
        if (!cancelled) {
          setLoading(false);
          toast.error(error instanceof Error ? error.message : '加载工作流失败');
        }
      });
    return () => {
      cancelled = true;
    };
    // requestedId 的 URL 校正由首次加载决定，避免每次切换重新请求整个目录。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, userId]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner label="加载 Flow Studio" />
      </div>
    );
  }

  return (
    <div className="relative flex h-full flex-col bg-background">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-border bg-card px-3">
        <div className="flex items-center gap-2">
          <Workflow className="size-4 text-accent" />
          <label className="relative">
            <select
              value={selected?.id ?? ''}
              onChange={(event) => navigate(event.target.value)}
              className="h-8 min-w-44 appearance-none rounded-lg border border-border bg-background py-1 pl-2.5 pr-8 text-xs font-medium outline-none focus:ring-2 focus:ring-ring"
            >
              {workflows.map((workflow) => (
                <option key={workflow.id} value={workflow.id}>
                  {workflow.name}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2 top-2 size-4 text-muted-foreground" />
          </label>
          <Button
            size="sm"
            variant="ghost"
            loading={creating}
            onClick={() => void createWorkflow()}
          >
            <Plus className="size-4" />
            新建
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <p className="text-[10px] text-muted-foreground">显式运行 · 精确模型 · 不自动产生调用</p>
          <Button size="sm" variant="outline" onClick={() => setAppsOpen(true)}>
            <AppWindow className="size-3.5" />
            Flow Apps
          </Button>
        </div>
      </div>
      {selected ? (
        <WorkflowProvider key={selected.id} workflowId={selected.id}>
          <FlowEditor
            projectId={projectId}
            workflowId={selected.id}
            workflowName={selected.name}
            models={models}
            assets={assets}
          />
        </WorkflowProvider>
      ) : (
        <div className="flex flex-1 items-center justify-center">
          <Button loading={creating} onClick={() => void createWorkflow('主工作流')}>
            创建第一个工作流
          </Button>
        </div>
      )}
      {appsOpen ? (
        <FlowAppLauncher
          projectId={projectId}
          assets={assets}
          onClose={() => setAppsOpen(false)}
          onLaunched={(workflow) => {
            setWorkflows((current) => [
              workflow,
              ...current.filter((item) => item.id !== workflow.id),
            ]);
            setAppsOpen(false);
            navigate(workflow.id);
          }}
        />
      ) : null}
    </div>
  );
}
