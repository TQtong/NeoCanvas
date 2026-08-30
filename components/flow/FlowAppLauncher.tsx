'use client';

/** 项目内 Flow App 简化表单与显式运行入口。 */

import { useEffect, useMemo, useState } from 'react';
import { AppWindow, Play, X } from 'lucide-react';
import type {
  AssetRow,
  FlowAppRow,
  FlowAppVersionRow,
  WorkflowExecuteResponse,
  WorkflowGraph,
  WorkflowPublishResponse,
  WorkflowRow,
  WorkflowTemplateVersionRow,
} from '@/types';
import { EDGE_FUNCTIONS } from '@/types';
import { getBrowserSupabase } from '@/lib/supabase/client';
import { invokeEdge } from '@/lib/edge/client';
import { getWorkflowNodeDefinition } from '@/lib/workflow/registry';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useToast } from '@/components/ui/toast';

type FieldValue = string | number | boolean | string[] | null;

export interface FlowAppLauncherProps {
  projectId: string;
  assets: AssetRow[];
  onClose: () => void;
  onLaunched: (workflow: WorkflowRow, runId: string) => void;
}

const fieldClass =
  'h-9 w-full rounded-lg border border-border bg-background px-2.5 text-sm outline-none focus:ring-2 focus:ring-ring';

export function FlowAppLauncher({ projectId, assets, onClose, onLaunched }: FlowAppLauncherProps) {
  const toast = useToast();
  const [apps, setApps] = useState<FlowAppRow[]>([]);
  const [versions, setVersions] = useState<FlowAppVersionRow[]>([]);
  const [templates, setTemplates] = useState<WorkflowTemplateVersionRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, FieldValue>>({});
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getBrowserSupabase()
      .from('flow_apps')
      .select('*')
      .eq('project_id', projectId)
      .order('updated_at', { ascending: false })
      .then(async ({ data }) => {
        const rows = (data ?? []) as FlowAppRow[];
        const appIds = rows.map((app) => app.id);
        const { data: versionData } =
          appIds.length > 0
            ? await getBrowserSupabase()
                .from('flow_app_versions')
                .select('*')
                .in('flow_app_id', appIds)
            : { data: [] };
        const versionRows = (versionData ?? []) as FlowAppVersionRow[];
        const templateIds = Array.from(
          new Set(versionRows.map((version) => version.template_version_id)),
        );
        const { data: templateData } =
          templateIds.length > 0
            ? await getBrowserSupabase()
                .from('workflow_template_versions')
                .select('*')
                .in('id', templateIds)
            : { data: [] };
        if (cancelled) return;
        setApps(rows);
        setVersions(versionRows);
        setTemplates((templateData ?? []) as WorkflowTemplateVersionRow[]);
        setSelectedId(rows[0]?.id ?? null);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const selectedApp = apps.find((app) => app.id === selectedId) ?? null;
  const selectedVersion =
    versions.find(
      (version) =>
        version.flow_app_id === selectedApp?.id && version.version === selectedApp.latest_version,
    ) ?? null;
  const template =
    templates.find((item) => item.id === selectedVersion?.template_version_id) ?? null;
  const graph = template?.graph as WorkflowGraph | undefined;

  useEffect(() => {
    if (!selectedVersion) return;
    setValues(
      Object.fromEntries(selectedVersion.fields.map((field) => [field.id, field.defaultValue])),
    );
  }, [selectedVersion]);

  const fields = useMemo(
    () => [...(selectedVersion?.fields ?? [])].sort((a, b) => a.order - b.order),
    [selectedVersion],
  );

  const launch = async () => {
    if (!selectedApp || !selectedVersion || !template || !graph) return;
    for (const field of fields) {
      const value = values[field.id];
      if (
        field.required &&
        (value === null || value === '' || (Array.isArray(value) && value.length === 0))
      ) {
        toast.error(`请填写 ${field.label}`);
        return;
      }
    }
    setRunning(true);
    try {
      const instance = await invokeEdge<Record<string, unknown>, WorkflowPublishResponse>(
        EDGE_FUNCTIONS.workflowPublish,
        {
          action: 'instantiate_template',
          projectId,
          templateVersionId: template.id,
          name: `${selectedApp.name} · ${new Date().toLocaleTimeString()}`,
        },
      );
      if (!instance.workflowId || !instance.nodeIdMap) throw new Error('Flow App 未返回工作流实例');
      const { data: newNodes, error: nodeError } = await getBrowserSupabase()
        .from('workflow_nodes')
        .select('*')
        .eq('workflow_id', instance.workflowId);
      if (nodeError) throw nodeError;
      const rows = new Map((newNodes ?? []).map((node) => [node.id, node]));
      const nextConfigs = new Map<string, Record<string, unknown>>();
      for (const field of fields) {
        const newNodeId = instance.nodeIdMap[field.nodeId];
        const row = newNodeId ? rows.get(newNodeId) : null;
        if (!row) throw new Error(`Flow App 字段节点 ${field.nodeId} 未映射`);
        const nextConfig = nextConfigs.get(row.id) ?? {
          ...(row.config as Record<string, unknown>),
        };
        nextConfig[field.configPath] = values[field.id];
        nextConfigs.set(row.id, nextConfig);
      }
      for (const [nodeId, config] of nextConfigs) {
        const { error } = await getBrowserSupabase()
          .from('workflow_nodes')
          .update({ config })
          .eq('id', nodeId)
          .eq('workflow_id', instance.workflowId);
        if (error) throw error;
      }
      const { data: workflow, error: workflowError } = await getBrowserSupabase()
        .from('workflows')
        .select('*')
        .eq('id', instance.workflowId)
        .single();
      if (workflowError || !workflow) throw workflowError ?? new Error('读取实例失败');
      const run = await invokeEdge<Record<string, unknown>, WorkflowExecuteResponse>(
        EDGE_FUNCTIONS.workflowExecute,
        {
          action: 'start',
          projectId,
          workflowId: workflow.id,
          expectedGraphRevision: workflow.graph_revision,
          idempotencyKey: crypto.randomUUID(),
          runMode: 'all',
          force: false,
        },
      );
      onLaunched(workflow, run.runId);
      toast.success('Flow App 已创建实例并开始运行');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Flow App 运行失败');
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="absolute inset-0 z-50 flex bg-black/25 backdrop-blur-[1px]">
      <button type="button" className="flex-1" aria-label="关闭 Flow Apps" onClick={onClose} />
      <aside
        aria-label="Flow Apps"
        className="flex h-full w-[420px] flex-col border-l border-border bg-card shadow-float"
      >
        <div className="flex h-14 items-center justify-between border-b border-border px-4">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <AppWindow className="size-4 text-accent" />
            Flow Apps
          </div>
          <button type="button" onClick={onClose}>
            <X className="size-4" />
          </button>
        </div>
        {loading ? (
          <div className="flex flex-1 items-center justify-center">
            <Spinner label="加载 Flow Apps" />
          </div>
        ) : (
          <div className="flex min-h-0 flex-1">
            <div className="w-36 shrink-0 border-r border-border p-2">
              {apps.length === 0 ? (
                <p className="p-2 text-xs text-muted-foreground">还没有已发布的 Flow App</p>
              ) : null}
              {apps.map((app) => (
                <button
                  key={app.id}
                  type="button"
                  onClick={() => setSelectedId(app.id)}
                  className={`mb-1 w-full rounded-lg px-2 py-2 text-left text-xs ${app.id === selectedId ? 'bg-accent-muted text-accent' : 'hover:bg-muted'}`}
                >
                  {app.name}
                  <span className="mt-0.5 block text-[9px] text-muted-foreground">
                    v{app.latest_version}
                  </span>
                </button>
              ))}
            </div>
            <div className="min-w-0 flex-1 overflow-y-auto p-4">
              {selectedApp && selectedVersion && graph ? (
                <div className="space-y-4">
                  <div>
                    <h3 className="text-sm font-semibold">{selectedApp.name}</h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {selectedApp.description || '填写输入后显式运行固定模板版本。'}
                    </p>
                  </div>
                  {fields.map((field) => {
                    const node = graph.nodes.find((item) => item.id === field.nodeId);
                    const value = values[field.id];
                    const isAsset = field.configPath === 'assetId';
                    const assetKind = node?.kind === 'video_input' ? 'video' : 'image';
                    return (
                      <label key={field.id} className="block">
                        <span className="mb-1 block text-[11px] font-medium text-muted-foreground">
                          {field.label}
                        </span>
                        {isAsset ? (
                          <select
                            className={fieldClass}
                            value={typeof value === 'string' ? value : ''}
                            onChange={(event) =>
                              setValues((current) => ({
                                ...current,
                                [field.id]: event.target.value,
                              }))
                            }
                          >
                            <option value="">选择项目资产…</option>
                            {assets
                              .filter((asset) => asset.kind === assetKind)
                              .map((asset) => (
                                <option key={asset.id} value={asset.id}>
                                  {asset.id.slice(0, 8)} · {asset.mime_type}
                                </option>
                              ))}
                          </select>
                        ) : typeof value === 'boolean' ? (
                          <input
                            type="checkbox"
                            checked={value}
                            onChange={(event) =>
                              setValues((current) => ({
                                ...current,
                                [field.id]: event.target.checked,
                              }))
                            }
                          />
                        ) : Array.isArray(value) ? (
                          <input
                            className={fieldClass}
                            value={value.join(',')}
                            onChange={(event) =>
                              setValues((current) => ({
                                ...current,
                                [field.id]: event.target.value
                                  .split(',')
                                  .map((item) => item.trim())
                                  .filter(Boolean),
                              }))
                            }
                          />
                        ) : (
                          <input
                            className={fieldClass}
                            type={typeof value === 'number' ? 'number' : 'text'}
                            value={value ?? ''}
                            onChange={(event) =>
                              setValues((current) => ({
                                ...current,
                                [field.id]:
                                  typeof value === 'number'
                                    ? Number(event.target.value)
                                    : event.target.value,
                              }))
                            }
                          />
                        )}
                        {node ? (
                          <span className="mt-1 block text-[9px] text-muted-foreground">
                            {getWorkflowNodeDefinition(node.kind).title}
                          </span>
                        ) : null}
                      </label>
                    );
                  })}
                  <Button className="w-full" loading={running} onClick={() => void launch()}>
                    <Play className="size-4" />
                    运行 Flow App
                  </Button>
                </div>
              ) : null}
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}
