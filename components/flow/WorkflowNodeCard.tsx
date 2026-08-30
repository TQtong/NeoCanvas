'use client';

/** Flow DAG 自定义节点卡。 */

import { memo } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { CircleAlert, CircleCheck, Clock3, LoaderCircle, Sparkles } from 'lucide-react';
import type { WorkflowGraphNode, WorkflowRunNodeStatus } from '@/types';
import { getWorkflowNodeDefinition } from '@/lib/workflow/registry';
import { cn } from '@/lib/utils/cn';

export interface WorkflowNodeCardData extends Record<string, unknown> {
  graphNode: WorkflowGraphNode;
  status?: WorkflowRunNodeStatus;
  stale: boolean;
  problemCount: number;
}

export type WorkflowFlowNode = Node<WorkflowNodeCardData, 'workflow'>;

const STATUS_STYLE: Partial<Record<WorkflowRunNodeStatus, string>> = {
  running: 'border-amber-400 shadow-[0_0_0_2px_rgb(251_191_36_/_0.15)]',
  waiting_generation: 'border-violet-400 shadow-[0_0_0_2px_rgb(167_139_250_/_0.15)]',
  waiting_user: 'border-sky-400 shadow-[0_0_0_2px_rgb(56_189_248_/_0.15)]',
  succeeded: 'border-emerald-400',
  cached: 'border-emerald-300 border-dashed',
  failed: 'border-danger',
  cancelled: 'opacity-60',
};

function StatusIcon({ status }: { status?: WorkflowRunNodeStatus }) {
  if (status === 'running' || status === 'waiting_generation') {
    return <LoaderCircle className="size-3.5 animate-spin text-amber-500" />;
  }
  if (status === 'waiting_user') return <Clock3 className="size-3.5 text-sky-500" />;
  if (status === 'succeeded' || status === 'cached') {
    return <CircleCheck className="size-3.5 text-emerald-500" />;
  }
  if (status === 'failed') return <CircleAlert className="size-3.5 text-danger" />;
  return null;
}

function WorkflowNodeCardComponent({ data, selected }: NodeProps<WorkflowFlowNode>) {
  const definition = getWorkflowNodeDefinition(data.graphNode.kind);
  const label =
    'label' in data.graphNode.config && typeof data.graphNode.config.label === 'string'
      ? data.graphNode.config.label
      : definition.title;
  const modelKey =
    'modelKey' in data.graphNode.config && typeof data.graphNode.config.modelKey === 'string'
      ? data.graphNode.config.modelKey
      : null;
  return (
    <div
      className={cn(
        'relative min-h-24 w-56 rounded-xl border bg-card shadow-soft transition-shadow',
        selected ? 'border-accent shadow-float' : 'border-border',
        data.status && STATUS_STYLE[data.status],
        data.problemCount > 0 && 'border-danger',
      )}
    >
      <div className="flex items-start gap-2 border-b border-border px-3 py-2.5">
        <span className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-accent-muted text-accent">
          <Sparkles className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium text-foreground">{label}</span>
            <StatusIcon status={data.status} />
          </div>
          <p className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-muted-foreground">
            {modelKey ?? definition.description}
          </p>
        </div>
      </div>
      <div className="flex min-h-10 items-center justify-between gap-4 px-3 py-2 text-[10px] text-muted-foreground">
        <div className="flex flex-col gap-1.5">
          {definition.inputs.map((input) => (
            <span key={input.id}>{input.label}</span>
          ))}
        </div>
        <div className="flex flex-col items-end gap-1.5">
          {definition.outputs.map((output) => (
            <span key={output.id}>{output.label}</span>
          ))}
        </div>
      </div>
      {data.stale ? (
        <span className="absolute -right-1.5 -top-1.5 rounded-full bg-amber-400 px-1.5 py-0.5 text-[9px] font-semibold text-black">
          STALE
        </span>
      ) : null}
      {definition.inputs.map((input, index) => (
        <Handle
          key={input.id}
          type="target"
          id={input.id}
          position={Position.Left}
          style={{ top: 64 + index * 22 }}
          className="!size-2.5 !border-2 !border-card !bg-muted-foreground"
          title={`${input.label} · ${input.valueType}`}
        />
      ))}
      {definition.outputs.map((output, index) => (
        <Handle
          key={output.id}
          type="source"
          id={output.id}
          position={Position.Right}
          style={{ top: 64 + index * 22 }}
          className="!size-2.5 !border-2 !border-card !bg-accent"
          title={`${output.label} · ${output.valueType}`}
        />
      ))}
    </div>
  );
}

export const WorkflowNodeCard = memo(WorkflowNodeCardComponent);
