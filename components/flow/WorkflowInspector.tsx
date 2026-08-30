'use client';

/** Flow 右侧配置、运行与 Agent 检查器。 */

import { useEffect, useState } from 'react';
import {
  Bot,
  Check,
  CircleAlert,
  CopyPlus,
  Play,
  RotateCcw,
  Save,
  Send,
  Square,
  Upload,
  X,
} from 'lucide-react';
import type {
  AssetRow,
  AssetView,
  FlowAppFieldBinding,
  FlowAppOutputBinding,
  ModelCatalogEntry,
  WorkflowAgentResponse,
  WorkflowExecuteResponse,
  WorkflowNodeConfig,
  WorkflowPublishResponse,
} from '@/types';
import { EDGE_FUNCTIONS } from '@/types';
import { useWorkflowStore } from '@/components/flow/WorkflowProvider';
import { getWorkflowNodeDefinition } from '@/lib/workflow/registry';
import { invokeEdge } from '@/lib/edge/client';
import { getBrowserSupabase } from '@/lib/supabase/client';
import { resolveAssetViews } from '@/lib/storage/signed-url';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils/cn';

type InspectorTab = 'config' | 'run' | 'agent';

export interface WorkflowInspectorProps {
  projectId: string;
  workflowId: string;
  workflowName: string;
  models: ModelCatalogEntry[];
  assets: AssetRow[];
  onRun: (
    mode: 'node' | 'downstream' | 'all',
    targetNodeId?: string,
    force?: boolean,
  ) => Promise<void>;
  onRefresh: () => Promise<void>;
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="mb-1 block text-[11px] font-medium text-muted-foreground">{children}</span>
  );
}

const inputClass =
  'h-9 w-full rounded-lg border border-border bg-background px-2.5 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring';

function ConfigTab({ models, assets }: Pick<WorkflowInspectorProps, 'models' | 'assets'>) {
  const selectedNodeId = useWorkflowStore((state) => state.selectedNodeId);
  const node = useWorkflowStore(
    (state) => state.nodes.find((item) => item.id === selectedNodeId) ?? null,
  );
  const updateNodeConfig = useWorkflowStore((state) => state.updateNodeConfig);
  const removeNode = useWorkflowStore((state) => state.removeNode);
  if (!node) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 text-center text-sm text-muted-foreground">
        选择一个节点以编辑配置
      </div>
    );
  }
  const definition = getWorkflowNodeDefinition(node.kind);
  const config = node.config as Record<string, unknown>;
  const setValue = (key: string, value: unknown) => {
    updateNodeConfig(node.id, { ...config, [key]: value } as WorkflowNodeConfig);
  };
  const modality =
    node.kind.startsWith('video') || node.kind === 'sequence_video' ? 'video' : 'image';
  const availableModels = models.filter((model) => model.modality === modality && model.isActive);
  const assetKind = node.kind === 'video_input' ? 'video' : 'image';

  return (
    <div className="space-y-4 p-4">
      <div>
        <h3 className="text-sm font-semibold text-foreground">{definition.title}</h3>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{definition.description}</p>
      </div>
      <label className="block">
        <FieldLabel>显示名称</FieldLabel>
        <input
          className={inputClass}
          value={typeof config.label === 'string' ? config.label : ''}
          onChange={(event) => setValue('label', event.target.value)}
          placeholder={definition.title}
        />
      </label>

      {node.kind === 'text_input' ? (
        <label className="block">
          <FieldLabel>文本</FieldLabel>
          <textarea
            className="min-h-32 w-full resize-y rounded-lg border border-border bg-background p-2.5 text-sm outline-none focus:ring-2 focus:ring-ring"
            value={typeof config.value === 'string' ? config.value : ''}
            onChange={(event) => setValue('value', event.target.value)}
          />
        </label>
      ) : null}
      {node.kind === 'prompt_template' || node.kind === 'note' ? (
        <label className="block">
          <FieldLabel>{node.kind === 'note' ? '注释' : '模板（使用 {{variables}}）'}</FieldLabel>
          <textarea
            className="min-h-32 w-full resize-y rounded-lg border border-border bg-background p-2.5 font-mono text-xs outline-none focus:ring-2 focus:ring-ring"
            value={stringConfig(config, node.kind === 'note' ? 'text' : 'template')}
            onChange={(event) =>
              setValue(node.kind === 'note' ? 'text' : 'template', event.target.value)
            }
          />
        </label>
      ) : null}
      {['image_input', 'video_input', 'mask_input'].includes(node.kind) ? (
        <label className="block">
          <FieldLabel>项目资产</FieldLabel>
          <select
            className={inputClass}
            value={stringConfig(config, 'assetId')}
            onChange={(event) => setValue('assetId', event.target.value || null)}
          >
            <option value="">选择资产…</option>
            {assets
              .filter((asset) => asset.kind === assetKind)
              .map((asset) => (
                <option key={asset.id} value={asset.id}>
                  {asset.id.slice(0, 8)} · {asset.mime_type}
                </option>
              ))}
          </select>
        </label>
      ) : null}
      {node.kind === 'image_collection' || node.kind === 'keyframe_collection' ? (
        <div>
          <FieldLabel>固定图片（连接的图片会追加在后）</FieldLabel>
          <div className="max-h-44 space-y-1 overflow-y-auto rounded-lg border border-border p-2">
            {assets
              .filter((asset) => asset.kind === 'image')
              .map((asset) => {
                const selected = arrayConfig(config, 'assetIds').includes(asset.id);
                return (
                  <label
                    key={asset.id}
                    className="flex items-center gap-2 rounded px-1 py-1 text-xs hover:bg-muted"
                  >
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={() =>
                        setValue(
                          'assetIds',
                          selected
                            ? arrayConfig(config, 'assetIds').filter((id) => id !== asset.id)
                            : [...arrayConfig(config, 'assetIds'), asset.id],
                        )
                      }
                    />
                    <span className="truncate">{asset.id}</span>
                  </label>
                );
              })}
          </div>
        </div>
      ) : null}
      {node.kind === 'image_select' ? (
        <div className="grid grid-cols-2 gap-2">
          <label>
            <FieldLabel>选择方式</FieldLabel>
            <select
              className={inputClass}
              value={stringConfig(config, 'mode', 'manual')}
              onChange={(event) => setValue('mode', event.target.value)}
            >
              <option value="manual">运行时人工选择</option>
              <option value="fixed">固定索引</option>
            </select>
          </label>
          <label>
            <FieldLabel>固定索引</FieldLabel>
            <input
              type="number"
              min={0}
              className={inputClass}
              value={numberConfig(config, 'selectedIndex', 0)}
              onChange={(event) => setValue('selectedIndex', Number(event.target.value))}
            />
          </label>
        </div>
      ) : null}
      {'modelKey' in config ? (
        <label className="block">
          <FieldLabel>精确模型绑定</FieldLabel>
          <select
            className={inputClass}
            value={stringConfig(config, 'modelKey')}
            onChange={(event) => setValue('modelKey', event.target.value || null)}
          >
            <option value="">选择模型…</option>
            {availableModels.map((model) => (
              <option key={model.key} value={model.key}>
                {model.displayName} · {model.key}
              </option>
            ))}
          </select>
          <p className="mt-1 text-[10px] text-muted-foreground">
            模型不可用时运行会阻断，不会自动替换。
          </p>
        </label>
      ) : null}
      {'count' in config && !['image_upscale', 'image_remove_background'].includes(node.kind) ? (
        <label className="block">
          <FieldLabel>输出数量</FieldLabel>
          <input
            type="number"
            min={1}
            max={8}
            className={inputClass}
            value={numberConfig(config, 'count', 1)}
            onChange={(event) => setValue('count', Number(event.target.value))}
          />
        </label>
      ) : null}
      {'aspectRatio' in config ? (
        <label className="block">
          <FieldLabel>画面比例</FieldLabel>
          <select
            className={inputClass}
            value={stringConfig(config, 'aspectRatio', '1:1')}
            onChange={(event) => setValue('aspectRatio', event.target.value)}
          >
            {['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3'].map((ratio) => (
              <option key={ratio}>{ratio}</option>
            ))}
          </select>
        </label>
      ) : null}
      {'factor' in config ? (
        <label className="block">
          <FieldLabel>放大倍数</FieldLabel>
          <select
            className={inputClass}
            value={numberConfig(config, 'factor', 2)}
            onChange={(event) => setValue('factor', Number(event.target.value))}
          >
            <option value={2}>2×</option>
            <option value={4}>4×</option>
          </select>
        </label>
      ) : null}
      {'durationSec' in config ? (
        <div className="grid grid-cols-2 gap-2">
          <label>
            <FieldLabel>时长（秒）</FieldLabel>
            <input
              type="number"
              min={1}
              max={60}
              className={inputClass}
              value={numberConfig(config, 'durationSec', 5)}
              onChange={(event) => setValue('durationSec', Number(event.target.value))}
            />
          </label>
          <label>
            <FieldLabel>分辨率</FieldLabel>
            <select
              className={inputClass}
              value={stringConfig(config, 'resolution', '720p')}
              onChange={(event) => setValue('resolution', event.target.value)}
            >
              <option>480p</option>
              <option>720p</option>
              <option>1080p</option>
            </select>
          </label>
        </div>
      ) : null}

      <Button variant="danger" size="sm" className="w-full" onClick={() => removeNode(node.id)}>
        删除节点
      </Button>
    </div>
  );
}

function stringConfig(config: Record<string, unknown>, key: string, fallback = ''): string {
  return typeof config[key] === 'string' ? config[key] : fallback;
}
function numberConfig(config: Record<string, unknown>, key: string, fallback: number): number {
  return typeof config[key] === 'number' ? config[key] : fallback;
}
function arrayConfig(config: Record<string, unknown>, key: string): string[] {
  return Array.isArray(config[key])
    ? (config[key] as unknown[]).filter((item): item is string => typeof item === 'string')
    : [];
}

function RunTab(props: WorkflowInspectorProps) {
  const toast = useToast();
  const selectedNodeId = useWorkflowStore((state) => state.selectedNodeId);
  const runs = useWorkflowStore((state) => state.runs);
  const runNodes = useWorkflowStore((state) => state.runNodes);
  const outputs = useWorkflowStore((state) => state.outputs);
  const activeRunId = useWorkflowStore((state) => state.activeRunId);
  const setActiveRun = useWorkflowStore((state) => state.setActiveRun);
  const nodes = useWorkflowStore((state) => state.nodes);
  const [busy, setBusy] = useState(false);
  const [selectedOutputs, setSelectedOutputs] = useState<Set<string>>(new Set());
  const [assetViews, setAssetViews] = useState<Map<string, AssetView>>(new Map());
  const [templateName, setTemplateName] = useState(props.workflowName);
  const [templateVersionId, setTemplateVersionId] = useState<string | null>(null);
  const [appName, setAppName] = useState(`${props.workflowName} App`);
  const [exposed, setExposed] = useState<Set<string>>(new Set());
  const activeRun = runs.find((run) => run.id === activeRunId) ?? runs[0] ?? null;
  const activeRunNodes = runNodes.filter((node) => node.run_id === activeRun?.id);
  const activeRunNodeIds = new Set(activeRunNodes.map((node) => node.id));
  const activeOutputs = outputs.filter((output) => activeRunNodeIds.has(output.run_node_id));
  const declaredOutputRunNodeIds = new Set(
    activeRunNodes
      .filter((node) =>
        ['text_output', 'image_output', 'video_output', 'gallery_output'].includes(node.kind),
      )
      .map((node) => node.id),
  );
  const declaredOutputs = activeOutputs.filter((output) =>
    declaredOutputRunNodeIds.has(output.run_node_id),
  );

  useEffect(() => setSelectedOutputs(new Set()), [activeRunId]);

  useEffect(() => {
    const currentRunNodeIds = new Set(
      runNodes.filter((node) => node.run_id === activeRunId).map((node) => node.id),
    );
    const ids = Array.from(
      new Set(
        outputs
          .filter((output) => currentRunNodeIds.has(output.run_node_id))
          .flatMap((output) => (output.asset_id ? [output.asset_id] : [])),
      ),
    );
    if (ids.length === 0) return;
    void getBrowserSupabase()
      .from('assets')
      .select('*')
      .in('id', ids)
      .then(async ({ data }) => {
        const views = await resolveAssetViews(getBrowserSupabase(), (data ?? []) as AssetRow[]);
        setAssetViews(new Map(views.map((view) => [view.id, view])));
      });
  }, [outputs, activeRunId, runNodes]);

  const action = async (task: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await task();
      await props.onRefresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '操作失败');
    } finally {
      setBusy(false);
    }
  };
  const invokeRunAction = async (
    actionName: 'resume' | 'retry' | 'cancel' | 'publish_output',
    extra: Record<string, unknown> = {},
  ) => {
    if (!activeRun) return;
    const result = await invokeEdge<Record<string, unknown>, WorkflowExecuteResponse>(
      EDGE_FUNCTIONS.workflowExecute,
      {
        action: actionName,
        projectId: props.projectId,
        workflowId: props.workflowId,
        runId: activeRun.id,
        idempotencyKey: crypto.randomUUID(),
        ...extra,
      },
    );
    setActiveRun(result.runId);
  };

  const publishTemplate = () =>
    action(async () => {
      const result = await invokeEdge<Record<string, unknown>, WorkflowPublishResponse>(
        EDGE_FUNCTIONS.workflowPublish,
        {
          action: 'publish_template',
          projectId: props.projectId,
          workflowId: props.workflowId,
          name: templateName,
        },
      );
      setTemplateVersionId(result.templateVersionId ?? null);
      toast.success('个人模板版本已发布');
    });
  const publishApp = () =>
    action(async () => {
      if (!templateVersionId) throw new Error('请先发布当前工作流模板版本');
      const requiredInputs = nodes.flatMap((node) => {
        if (node.kind === 'text_input') return [`${node.id}:value`];
        if (['image_input', 'video_input', 'mask_input'].includes(node.kind)) {
          return [`${node.id}:assetId`];
        }
        return [];
      });
      const fields: FlowAppFieldBinding[] = [];
      for (const key of new Set([...requiredInputs, ...exposed])) {
        const [nodeId, configPath] = key.split(':');
        const node = nodes.find((item) => item.id === nodeId);
        if (!nodeId || !node || !configPath) continue;
        const config = node.config as Record<string, unknown>;
        const rawDefault = config[configPath];
        const defaultValue = Array.isArray(rawDefault)
          ? rawDefault.filter((item): item is string => typeof item === 'string')
          : typeof rawDefault === 'string' ||
              typeof rawDefault === 'number' ||
              typeof rawDefault === 'boolean'
            ? rawDefault
            : null;
        fields.push({
          id: crypto.randomUUID(),
          nodeId,
          configPath,
          label: `${getWorkflowNodeDefinition(node.kind).title} · ${configPath}`,
          order: fields.length,
          required: true,
          defaultValue,
        });
      }
      const outputBindings: FlowAppOutputBinding[] = nodes
        .filter((node) =>
          ['text_output', 'image_output', 'video_output', 'gallery_output'].includes(node.kind),
        )
        .map((node, order) => ({
          nodeId: node.id,
          portId: getWorkflowNodeDefinition(node.kind).outputs[0]?.id ?? 'output',
          label: getWorkflowNodeDefinition(node.kind).title,
          order,
        }));
      await invokeEdge<Record<string, unknown>, WorkflowPublishResponse>(
        EDGE_FUNCTIONS.workflowPublish,
        {
          action: 'publish_app',
          projectId: props.projectId,
          templateVersionId,
          name: appName,
          fields,
          outputs: outputBindings,
        },
      );
      toast.success('Flow App 已发布到当前项目');
    });

  const exposable = nodes.flatMap((node) =>
    getWorkflowNodeDefinition(node.kind).appExposablePaths.map((path) => ({ node, path })),
  );

  return (
    <div className="space-y-5 p-4">
      <section>
        <h3 className="mb-2 text-xs font-semibold text-foreground">执行</h3>
        <div className="grid grid-cols-2 gap-2">
          <Button size="sm" loading={busy} onClick={() => void props.onRun('all')}>
            <Play className="size-3.5" />
            运行全部
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!selectedNodeId || busy}
            onClick={() => selectedNodeId && void props.onRun('node', selectedNodeId)}
          >
            运行节点
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!selectedNodeId || busy}
            onClick={() => selectedNodeId && void props.onRun('downstream', selectedNodeId)}
          >
            运行下游
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void props.onRun(
                selectedNodeId ? 'downstream' : 'all',
                selectedNodeId ?? undefined,
                true,
              )
            }
          >
            <RotateCcw className="size-3.5" />
            {selectedNodeId ? '强制重跑下游' : '强制重跑'}
          </Button>
        </div>
        {activeRun && ['queued', 'running', 'waiting_user'].includes(activeRun.status) ? (
          <Button
            size="sm"
            variant="danger"
            className="mt-2 w-full"
            loading={busy}
            onClick={() => void action(() => invokeRunAction('cancel'))}
          >
            <Square className="size-3.5" />
            取消运行
          </Button>
        ) : null}
      </section>

      <section>
        <h3 className="mb-2 text-xs font-semibold text-foreground">运行历史</h3>
        <div className="space-y-1">
          {runs.length === 0 ? (
            <p className="text-xs text-muted-foreground">还没有运行记录</p>
          ) : null}
          {runs.map((run) => (
            <button
              key={run.id}
              type="button"
              onClick={() => setActiveRun(run.id)}
              className={cn(
                'flex w-full items-center justify-between rounded-lg border px-2.5 py-2 text-xs',
                run.id === activeRun?.id
                  ? 'border-accent bg-accent-muted'
                  : 'border-border hover:bg-muted',
              )}
            >
              <span>{new Date(run.created_at).toLocaleString()}</span>
              <span className="font-medium">{run.status}</span>
            </button>
          ))}
        </div>
      </section>

      {activeRun ? (
        <section>
          <h3 className="mb-2 text-xs font-semibold text-foreground">节点状态</h3>
          <div className="space-y-1">
            {activeRunNodes.map((node) => (
              <div
                key={node.id}
                className="flex items-center justify-between rounded bg-muted px-2 py-1.5 text-[11px]"
              >
                <span>{getWorkflowNodeDefinition(node.kind).title}</span>
                <span className={cn(node.status === 'failed' && 'text-danger')}>{node.status}</span>
                {node.status === 'failed' ? (
                  <button
                    title="从此节点重试"
                    onClick={() =>
                      void action(() => invokeRunAction('retry', { runNodeId: node.id }))
                    }
                  >
                    <RotateCcw className="size-3.5" />
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {activeRun?.status === 'waiting_user' ? (
        <section className="rounded-xl border border-sky-300 bg-sky-50/50 p-3 dark:bg-sky-950/20">
          <h3 className="text-xs font-semibold">等待选择图片</h3>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {activeOutputs
              .filter((output) => output.asset_id)
              .map((output) => {
                const view = output.asset_id ? assetViews.get(output.asset_id) : null;
                return (
                  <button
                    key={output.id}
                    type="button"
                    className="overflow-hidden rounded-lg border border-border bg-card"
                    onClick={() => {
                      const waiting = activeRunNodes.find((node) => node.status === 'waiting_user');
                      if (waiting)
                        void action(() =>
                          invokeRunAction('resume', {
                            runNodeId: waiting.id,
                            selectedOutputId: output.id,
                          }),
                        );
                    }}
                  >
                    {view?.thumbnailUrl || view?.url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={view.thumbnailUrl ?? view.url}
                        alt="候选"
                        className="h-20 w-full object-cover"
                      />
                    ) : (
                      <span className="block p-3 text-[10px]">{output.asset_id?.slice(0, 8)}</span>
                    )}
                  </button>
                );
              })}
          </div>
        </section>
      ) : null}

      {declaredOutputs.length > 0 ? (
        <section>
          <h3 className="mb-2 text-xs font-semibold text-foreground">输出</h3>
          <div className="grid grid-cols-2 gap-2">
            {declaredOutputs.map((output) => {
              const view = output.asset_id ? assetViews.get(output.asset_id) : null;
              const selected = selectedOutputs.has(output.id);
              return (
                <button
                  key={output.id}
                  type="button"
                  onClick={() =>
                    setSelectedOutputs((current) => {
                      const next = new Set(current);
                      if (selected) next.delete(output.id);
                      else next.add(output.id);
                      return next;
                    })
                  }
                  className={cn(
                    'relative overflow-hidden rounded-lg border bg-card text-left',
                    selected ? 'border-accent ring-2 ring-accent/20' : 'border-border',
                  )}
                >
                  {view?.thumbnailUrl || view?.url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={view.thumbnailUrl ?? view.url}
                      alt="运行输出"
                      className="h-20 w-full object-cover"
                    />
                  ) : (
                    <span className="block p-3 text-[10px]">
                      {String(output.value ?? output.asset_id ?? '')}
                    </span>
                  )}
                  <span className="block truncate px-2 py-1 text-[9px] text-muted-foreground">
                    {output.port_id}
                  </span>
                  {selected ? (
                    <Check className="absolute right-1 top-1 size-4 rounded-full bg-accent p-0.5 text-white" />
                  ) : null}
                </button>
              );
            })}
          </div>
          <Button
            size="sm"
            className="mt-2 w-full"
            disabled={selectedOutputs.size === 0 || busy}
            onClick={() =>
              void action(() =>
                invokeRunAction('publish_output', {
                  outputIds: [...selectedOutputs],
                }),
              )
            }
          >
            <Upload className="size-3.5" />
            发布到 Canvas
          </Button>
        </section>
      ) : null}

      <section className="border-t border-border pt-4">
        <h3 className="mb-2 text-xs font-semibold text-foreground">个人模板与 Flow App</h3>
        <input
          className={inputClass}
          value={templateName}
          onChange={(event) => setTemplateName(event.target.value)}
        />
        <Button
          size="sm"
          variant="outline"
          className="mt-2 w-full"
          loading={busy}
          onClick={publishTemplate}
        >
          <Save className="size-3.5" />
          发布不可变模板版本
        </Button>
        {templateVersionId ? (
          <div className="mt-3 space-y-2 rounded-lg border border-border p-2">
            <input
              className={inputClass}
              value={appName}
              onChange={(event) => setAppName(event.target.value)}
            />
            <p className="text-[10px] text-muted-foreground">选择 Flow App 表单允许修改的字段：</p>
            <div className="max-h-32 space-y-1 overflow-y-auto">
              {exposable.map(({ node, path }) => {
                const key = `${node.id}:${path}`;
                return (
                  <label key={key} className="flex items-center gap-2 text-[10px]">
                    <input
                      type="checkbox"
                      checked={exposed.has(key)}
                      onChange={() =>
                        setExposed((current) => {
                          const next = new Set(current);
                          if (next.has(key)) next.delete(key);
                          else next.add(key);
                          return next;
                        })
                      }
                    />
                    {getWorkflowNodeDefinition(node.kind).title} · {path}
                  </label>
                );
              })}
            </div>
            <Button size="sm" className="w-full" loading={busy} onClick={publishApp}>
              <CopyPlus className="size-3.5" />
              发布 Flow App
            </Button>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function AgentTab(props: WorkflowInspectorProps) {
  const toast = useToast();
  const graphRevision = useWorkflowStore((state) => state.graphRevision);
  const [instruction, setInstruction] = useState('');
  const [proposal, setProposal] = useState<WorkflowAgentResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const send = async (action: 'propose' | 'apply' | 'reject') => {
    setBusy(true);
    try {
      const result = await invokeEdge<Record<string, unknown>, WorkflowAgentResponse>(
        EDGE_FUNCTIONS.workflowAgent,
        {
          action,
          projectId: props.projectId,
          workflowId: props.workflowId,
          baseGraphRevision: graphRevision,
          instruction: action === 'propose' ? instruction : undefined,
          proposalId: action === 'propose' ? undefined : proposal?.proposalId,
        },
      );
      setProposal(result);
      if (result.status === 'applied') {
        toast.success('Agent 变更已应用；不会自动运行');
        await props.onRefresh();
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Agent 操作失败');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4 p-4">
      <div className="rounded-xl border border-border bg-muted/40 p-3">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Bot className="size-4 text-accent" />
          Flow Agent
        </div>
        <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
          Agent 只提出图差异。你确认后才会应用，并且永远不会自动运行或删除历史结果。
        </p>
      </div>
      <textarea
        className="min-h-32 w-full resize-y rounded-lg border border-border bg-background p-2.5 text-sm outline-none focus:ring-2 focus:ring-ring"
        value={instruction}
        onChange={(event) => setInstruction(event.target.value)}
        placeholder="例如：增加四图生成、人工选择和 2× 放大流程"
      />
      <Button
        className="w-full"
        loading={busy}
        disabled={!instruction.trim()}
        onClick={() => void send('propose')}
      >
        <Send className="size-4" />
        生成差异提案
      </Button>
      {proposal ? (
        <div className="rounded-xl border border-border p-3">
          <div className="flex items-center justify-between text-xs font-semibold">
            <span>Patch 差异</span>
            <span>{proposal.status}</span>
          </div>
          <div className="mt-2 max-h-64 space-y-1 overflow-y-auto">
            {proposal.operations.map((operation, index) => (
              <div
                key={`${operation.op}-${index}`}
                className="rounded bg-muted px-2 py-1.5 font-mono text-[10px]"
              >
                {operation.op}{' '}
                {'nodeId' in operation
                  ? operation.nodeId
                  : 'edgeId' in operation
                    ? operation.edgeId
                    : ''}
              </div>
            ))}
          </div>
          {proposal.status === 'pending' ? (
            <div className="mt-3 grid grid-cols-2 gap-2">
              <Button
                size="sm"
                variant="outline"
                loading={busy}
                onClick={() => void send('reject')}
              >
                <X className="size-3.5" />
                拒绝
              </Button>
              <Button size="sm" loading={busy} onClick={() => void send('apply')}>
                <Check className="size-3.5" />
                确认应用
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function WorkflowInspector(props: WorkflowInspectorProps) {
  const [tab, setTab] = useState<InspectorTab>('config');
  const problems = useWorkflowStore((state) => state.problems);
  return (
    <aside className="flex h-full w-80 shrink-0 flex-col border-l border-border bg-card">
      <div className="grid grid-cols-3 border-b border-border p-1.5">
        {(['config', 'run', 'agent'] as const).map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => setTab(item)}
            className={cn(
              'rounded-lg px-2 py-2 text-xs font-medium transition-colors',
              tab === item
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:bg-muted',
            )}
          >
            {item === 'config' ? '配置' : item === 'run' ? '运行' : 'Agent'}
          </button>
        ))}
      </div>
      {problems.length > 0 ? (
        <div className="flex items-start gap-2 border-b border-danger/30 bg-danger/5 px-3 py-2 text-[10px] text-danger">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {problems.length} 个图校验问题：{problems[0]?.message}
          </span>
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'config' ? <ConfigTab models={props.models} assets={props.assets} /> : null}
        {tab === 'run' ? <RunTab {...props} /> : null}
        {tab === 'agent' ? <AgentTab {...props} /> : null}
      </div>
    </aside>
  );
}
