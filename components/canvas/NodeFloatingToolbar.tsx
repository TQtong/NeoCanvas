'use client';

/**
 * 节点浮动工具条（第 01 篇、第 04 篇组件清单）。
 *
 * 单选节点时在其上方浮现一条与元素类型相关的工具条：通用提供复制 / 置顶 / 置底 / 删除；
 * 图片 / 视频额外提供「以此为参考再生成」（提及该节点并聚焦对话）与「替换」；文本提供
 * 字号 / 颜色 / 对齐等排版属性；形状提供填充 / 描边。多选时由组变换层处理。
 *
 * @module components/canvas/NodeFloatingToolbar
 */

import { useRef } from 'react';
import { NodeToolbar, Position } from '@xyflow/react';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDownToLine,
  ArrowUpToLine,
  Bold,
  Copy,
  Italic,
  Replace,
  Sparkles,
  Trash2,
  Underline,
} from 'lucide-react';
import type { ShapeNodeData, TextAlign, TextNodeData } from '@/types';
import { useCanvasStore } from '@/stores/canvas-store';
import { useChatStore } from '@/stores/chat-store';
import { useSessionStore } from '@/stores/session-store';
import { getBrowserSupabase } from '@/lib/supabase/client';
import { uploadAsset } from '@/lib/storage/upload';
import { IconButton } from '@/components/ui/icon-button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip } from '@/components/ui/tooltip';
import { useToast } from '@/components/ui/toast';
import { useTranslation } from '@/i18n';

/** 文本属性子面板。 */
function TextProperties({ id, data }: { id: string; data: TextNodeData }) {
  const updateNodeData = useCanvasStore((s) => s.updateNodeData);
  const aligns: Array<{ value: TextAlign; icon: typeof AlignLeft }> = [
    { value: 'left', icon: AlignLeft },
    { value: 'center', icon: AlignCenter },
    { value: 'right', icon: AlignRight },
  ];
  return (
    <div className="flex w-60 flex-col gap-3 p-1">
      <label className="flex items-center justify-between gap-2 text-sm">
        字号
        <input
          type="number"
          min={8}
          max={200}
          value={data.fontSize}
          onChange={(e) => updateNodeData(id, { fontSize: Number(e.target.value) })}
          className="h-8 w-20 rounded-lg border border-border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
      </label>
      <label className="flex items-center justify-between gap-2 text-sm">
        颜色
        <input
          type="color"
          value={data.color.startsWith('#') ? data.color : '#1a1a1f'}
          onChange={(e) => updateNodeData(id, { color: e.target.value })}
          className="h-8 w-12 cursor-pointer rounded-lg border border-border bg-background"
        />
      </label>
      <div className="flex items-center gap-1">
        {aligns.map(({ value, icon: Icon }) => (
          <IconButton
            key={value}
            size="sm"
            label={value}
            active={data.align === value}
            onClick={() => updateNodeData(id, { align: value })}
          >
            <Icon />
          </IconButton>
        ))}
        <div className="mx-1 h-5 w-px bg-border" />
        <IconButton
          size="sm"
          label="加粗"
          active={data.fontWeight >= 600}
          onClick={() => updateNodeData(id, { fontWeight: data.fontWeight >= 600 ? 400 : 700 })}
        >
          <Bold />
        </IconButton>
        <IconButton size="sm" label="斜体" active={data.italic} onClick={() => updateNodeData(id, { italic: !data.italic })}>
          <Italic />
        </IconButton>
        <IconButton
          size="sm"
          label="下划线"
          active={data.underline}
          onClick={() => updateNodeData(id, { underline: !data.underline })}
        >
          <Underline />
        </IconButton>
      </div>
    </div>
  );
}

/** 形状属性子面板。 */
function ShapeProperties({ id, data }: { id: string; data: ShapeNodeData }) {
  const updateNodeData = useCanvasStore((s) => s.updateNodeData);
  return (
    <div className="flex w-52 flex-col gap-3 p-1">
      <label className="flex items-center justify-between gap-2 text-sm">
        填充
        <input
          type="color"
          value={data.fill.startsWith('#') ? data.fill : '#7c3aed'}
          onChange={(e) => updateNodeData(id, { fill: e.target.value })}
          className="h-8 w-12 cursor-pointer rounded-lg border border-border bg-background"
        />
      </label>
      <label className="flex items-center justify-between gap-2 text-sm">
        描边
        <input
          type="color"
          value={data.stroke.startsWith('#') ? data.stroke : '#7c3aed'}
          onChange={(e) => updateNodeData(id, { stroke: e.target.value })}
          className="h-8 w-12 cursor-pointer rounded-lg border border-border bg-background"
        />
      </label>
      <label className="flex items-center justify-between gap-2 text-sm">
        描边宽
        <input
          type="number"
          min={0}
          max={40}
          value={data.strokeWidth}
          onChange={(e) => updateNodeData(id, { strokeWidth: Number(e.target.value) })}
          className="h-8 w-20 rounded-lg border border-border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
      </label>
    </div>
  );
}

/**
 * 节点浮动工具条。须置于 ReactFlowProvider 内。
 */
export function NodeFloatingToolbar() {
  const { t } = useTranslation();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);

  const selectedNodeIds = useCanvasStore((s) => s.selectedNodeIds);
  const nodes = useCanvasStore((s) => s.nodes);
  const removeNodes = useCanvasStore((s) => s.removeNodes);
  const duplicateSelection = useCanvasStore((s) => s.duplicateSelection);
  const bringToFront = useCanvasStore((s) => s.bringToFront);
  const sendToBack = useCanvasStore((s) => s.sendToBack);
  const updateNodeData = useCanvasStore((s) => s.updateNodeData);
  const projectId = useCanvasStore((s) => s.projectId);

  const addMention = useChatStore((s) => s.addMention);
  const requestFocus = useChatStore((s) => s.requestFocus);
  const profile = useSessionStore((s) => s.profile);

  if (selectedNodeIds.length !== 1) return null;
  const node = nodes.find((n) => n.id === selectedNodeIds[0]);
  if (!node) return null;

  const isMedia = node.data.type === 'image' || node.data.type === 'video';

  const onRegenerate = () => {
    addMention({
      nodeId: node.id,
      nodeType: node.data.type,
      label: node.data.type === 'image' ? '图片' : node.data.type === 'video' ? '视频' : '元素',
      assetId: node.data.type === 'image' || node.data.type === 'video' ? node.data.assetId : null,
    });
    requestFocus();
  };

  const onReplaceFile = async (file: File) => {
    if (!profile) return;
    try {
      const asset = await uploadAsset(getBrowserSupabase(), {
        file,
        userId: profile.id,
        projectId,
      });
      updateNodeData(node.id, {
        assetId: asset.id,
        src: asset.url,
        thumbnailSrc: asset.thumbnailUrl,
        naturalWidth: asset.width,
        naturalHeight: asset.height,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '替换失败');
    }
  };

  return (
    <NodeToolbar nodeId={node.id} isVisible position={Position.Top} offset={12}>
      <div className="glass flex items-center gap-0.5 rounded-xl p-1">
        {isMedia ? (
          <>
            <Tooltip content={t('node.regenerate')}>
              <IconButton size="sm" label={t('node.regenerate')} className="text-accent" onClick={onRegenerate}>
                <Sparkles />
              </IconButton>
            </Tooltip>
            <Tooltip content={t('node.replace')}>
              <IconButton size="sm" label={t('node.replace')} onClick={() => fileRef.current?.click()}>
                <Replace />
              </IconButton>
            </Tooltip>
            <input
              ref={fileRef}
              type="file"
              accept="image/*,video/*"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void onReplaceFile(file);
                e.target.value = '';
              }}
            />
            <div className="mx-0.5 h-5 w-px bg-border" />
          </>
        ) : null}

        {node.data.type === 'text' ? (
          <Popover>
            <PopoverTrigger asChild>
              <button className="rounded-md px-2 py-1 text-sm font-medium text-foreground hover:bg-muted">
                Aa
              </button>
            </PopoverTrigger>
            <PopoverContent side="top">
              <TextProperties id={node.id} data={node.data as TextNodeData} />
            </PopoverContent>
          </Popover>
        ) : null}

        {node.data.type === 'shape' ? (
          <Popover>
            <PopoverTrigger asChild>
              <button className="size-7 rounded-md border border-border" style={{ background: (node.data as ShapeNodeData).fill }} aria-label="形状属性" />
            </PopoverTrigger>
            <PopoverContent side="top">
              <ShapeProperties id={node.id} data={node.data as ShapeNodeData} />
            </PopoverContent>
          </Popover>
        ) : null}

        <Tooltip content={t('node.duplicate')}>
          <IconButton size="sm" label={t('node.duplicate')} onClick={() => duplicateSelection()}>
            <Copy />
          </IconButton>
        </Tooltip>
        <Tooltip content={t('node.bringToFront')}>
          <IconButton size="sm" label={t('node.bringToFront')} onClick={() => bringToFront([node.id])}>
            <ArrowUpToLine />
          </IconButton>
        </Tooltip>
        <Tooltip content={t('node.sendToBack')}>
          <IconButton size="sm" label={t('node.sendToBack')} onClick={() => sendToBack([node.id])}>
            <ArrowDownToLine />
          </IconButton>
        </Tooltip>
        <Tooltip content={t('node.delete')}>
          <IconButton size="sm" label={t('node.delete')} className="hover:text-danger" onClick={() => removeNodes([node.id])}>
            <Trash2 />
          </IconButton>
        </Tooltip>
      </div>
    </NodeToolbar>
  );
}
