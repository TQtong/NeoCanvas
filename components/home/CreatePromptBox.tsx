'use client';

/**
 * 主页创作输入框（第 01 篇、第 05 篇第七节）。
 *
 * 玻璃质感的大圆角卡片：顶部为多行自适应文本域，左下为附件按钮（本地暂存 File[] 仅展示
 * 计数），右下为模态占位（Cuboid）与发送按钮（ArrowUp）。卡片正下方挂载
 * {@link ModelSceneSelector} 供切换模型与场景。整体为一个提交到服务端动作
 * `createProjectAction` 的表单，用隐藏 input 携带 prompt / modelKey / scene。
 *
 * @module components/home/CreatePromptBox
 */

import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUp, Cuboid, Paperclip } from 'lucide-react';
import { createProjectAction } from '@/app/actions';
import type { ModelCatalogEntry, Scene } from '@/types';
import { IconButton } from '@/components/ui/icon-button';
import { Tooltip } from '@/components/ui/tooltip';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils/cn';
import { ModelSceneSelector } from './ModelSceneSelector';

/** {@link CreatePromptBox} 属性。 */
export interface CreatePromptBoxProps {
  /** 可选模型目录（服务端预取）。 */
  models: ModelCatalogEntry[];
  /** 默认所选模型键（来自上次会话或服务端默认）。 */
  defaultModelKey?: string | null;
}

/** 文本域最大自适应高度（像素），超出后内部滚动。 */
const TEXTAREA_MAX_HEIGHT = 200;

/** 缺省模型键：服务端未给出默认时退回到主图像模型。 */
const FALLBACK_MODEL_KEY = 'gpt-image-2';

/**
 * 创作输入框组件。
 *
 * @param props - 见 {@link CreatePromptBoxProps}
 * @returns 创作输入框节点
 */
export function CreatePromptBox({ models, defaultModelKey }: CreatePromptBoxProps) {
  const { t } = useTranslation();

  // 本地草稿、所选模型与场景
  const [prompt, setPrompt] = useState('');
  const [modelKey, setModelKey] = useState<string>(defaultModelKey || FALLBACK_MODEL_KEY);
  const [scene, setScene] = useState<Scene | null>(null);
  // 本地暂存的附件文件（此处仅展示计数，真正上传在进入项目后进行）
  const [attachments, setAttachments] = useState<File[]>([]);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 文本域随内容自适应高度（在最大高度内增长，超出则内部滚动）
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, TEXTAREA_MAX_HEIGHT)}px`;
  }, [prompt]);

  // 选择附件后合并入本地暂存列表，并清空 input 以便重复选择同名文件
  const handleFilesSelected = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files;
    if (!picked || picked.length === 0) return;
    setAttachments((prev) => [...prev, ...Array.from(picked)]);
    event.target.value = '';
  }, []);

  const trimmed = prompt.trim();
  const canSubmit = trimmed.length > 0;

  return (
    <form
      action={createProjectAction}
      className="glass mx-auto flex w-full max-w-3xl flex-col gap-4 rounded-3xl p-3 shadow-float"
    >
      {/* 隐藏字段：把本地草稿、所选模型与场景随表单提交到服务端动作 */}
      <input type="hidden" name="prompt" value={prompt} />
      <input type="hidden" name="modelKey" value={modelKey} />
      <input type="hidden" name="scene" value={scene ?? ''} />

      <div className="rounded-2xl bg-card/60 p-2">
        {/* 多行自适应文本域 */}
        <textarea
          ref={textareaRef}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder={t('home.promptPlaceholder')}
          rows={1}
          className={cn(
            'block w-full resize-none border-none bg-transparent px-3 pt-2 text-base leading-relaxed',
            'text-foreground placeholder:text-muted-foreground focus:outline-none',
          )}
        />

        {/* 工具行：左下附件，右下模态占位 + 发送 */}
        <div className="mt-1 flex items-center justify-between px-1">
          <div className="flex items-center gap-2">
            {/* 隐藏的原生文件选择器 */}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*,video/*"
              className="hidden"
              onChange={handleFilesSelected}
            />
            <Tooltip content={t('home.attach')}>
              <IconButton
                size="md"
                label={t('home.attach')}
                onClick={() => fileInputRef.current?.click()}
              >
                <Paperclip />
              </IconButton>
            </Tooltip>
            {/* 仅展示已选附件计数，不在此处上传 */}
            {attachments.length > 0 ? (
              <span className="text-sm tabular-nums text-muted-foreground">
                {attachments.length}
              </span>
            ) : null}
          </div>

          <div className="flex items-center gap-1.5">
            {/* 模态占位（Cuboid）：完整模态切换在进入项目后的对话面板中进行 */}
            <Tooltip content="3D">
              <IconButton size="md" label="3D" disabled>
                <Cuboid />
              </IconButton>
            </Tooltip>
            {/* 发送：提交表单；prompt 为空时禁用 */}
            <button
              type="submit"
              disabled={!canSubmit}
              aria-label={t('home.send')}
              title={t('home.send')}
              className={cn(
                'inline-flex size-9 items-center justify-center rounded-full transition-colors duration-150',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                canSubmit
                  ? 'bg-accent text-accent-foreground hover:bg-accent/90 shadow-soft'
                  : 'cursor-not-allowed bg-muted text-muted-foreground',
              )}
            >
              <ArrowUp className="size-[18px]" />
            </button>
          </div>
        </div>
      </div>

      {/* 模型 / 场景选择条 */}
      <ModelSceneSelector
        models={models}
        modelKey={modelKey}
        scene={scene}
        onModelChange={setModelKey}
        onSceneChange={setScene}
      />
    </form>
  );
}
