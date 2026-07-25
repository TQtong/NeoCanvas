'use client';

/**
 * 主页创作输入框（第 01 篇、第 05 篇第七节）。
 *
 * 玻璃质感的大圆角卡片：顶部为多行自适应文本域，左下为附件按钮（本地暂存 File[] 仅展示
 * 计数），右下为模态占位（Cuboid）与发送按钮（ArrowUp）。卡片正下方挂载
 * {@link ModelSelector} 供切换生成模态与具体模型。整体为一个提交到服务端动作
 * `createProjectAction` 的表单，用隐藏 input 携带 prompt / modelKey。
 *
 * @module components/home/CreatePromptBox
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUp, Cuboid, Loader2, Paperclip } from 'lucide-react';
import { createProjectAction } from '@/app/actions';
import type { MessageAttachment, ModelCatalogEntry } from '@/types';
import { getBrowserSupabase } from '@/lib/supabase/client';
import { uploadAsset } from '@/lib/storage/upload';
import { IconButton } from '@/components/ui/icon-button';
import { Tooltip } from '@/components/ui/tooltip';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils/cn';
import { useModelCatalog } from '@/lib/hooks/use-model-catalog';
import { ModelSelector } from './ModelSelector';

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
const FALLBACK_MODEL_KEY = 'siliconflow-kolors';

/**
 * 从已加载目录解析首页初始模型，避免默认键下架后提交一个目录中不存在的模型。
 *
 * @param models - 当前可用模型目录
 * @param defaultModelKey - 用户或服务端给出的默认键
 * @returns 可用模型键；目录为空时返回空字符串
 */
function resolveInitialModelKey(
  models: ModelCatalogEntry[],
  defaultModelKey?: string | null,
): string {
  if (defaultModelKey && models.some((model) => model.key === defaultModelKey)) {
    return defaultModelKey;
  }
  return (
    models.find((model) => model.key === FALLBACK_MODEL_KEY)?.key ??
    models.find((model) => model.modality === 'image')?.key ??
    models[0]?.key ??
    ''
  );
}

/**
 * 创作输入框组件。
 *
 * @param props - 见 {@link CreatePromptBoxProps}
 * @returns 创作输入框节点
 */
export function CreatePromptBox({ models, defaultModelKey }: CreatePromptBoxProps) {
  const { t } = useTranslation();
  const availableModels = useModelCatalog(models);

  // 本地草稿与所选模型；模型模态直接决定新会话的生成类型
  const [prompt, setPrompt] = useState('');
  const [modelKey, setModelKey] = useState<string>(() =>
    resolveInitialModelKey(models, defaultModelKey),
  );
  // 每次挂载生成一个稳定的请求标识：连点 / 失败重试复用同一值以避免重复建项目
  const [requestId] = useState(() =>
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.round(Math.random() * 1e9)}`,
  );
  // 本地暂存的附件文件（提交时上传到 uploads 桶并随 create-project 携带为参考素材）
  const [attachments, setAttachments] = useState<File[]>([]);
  // 提交中（含附件上传）态与错误提示
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 凭据启停或删除会改变可用目录；当前模型失效时立即切换到仍可用的首选模型。
  useEffect(() => {
    if (!availableModels.some((model) => model.key === modelKey)) {
      setModelKey(resolveInitialModelKey(availableModels, defaultModelKey));
    }
  }, [availableModels, defaultModelKey, modelKey]);

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
  const canSubmit = trimmed.length > 0 && availableModels.some((model) => model.key === modelKey);

  /**
   * 提交创作：先把本地附件上传到 uploads 桶、登记资产，再把资产引用随
   * create-project 一并提交（作为首次生成的参考素材）。附件上传失败则中止并提示；
   * create-project 在上传之后调用，其重定向由服务端动作原生处理。
   */
  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    setError(null);

    // 复用隐藏字段（prompt / modelKey / clientRequestId）
    const formData = new FormData(event.currentTarget);

    if (attachments.length > 0) {
      try {
        const supabase = getBrowserSupabase();
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (user) {
          const refs: MessageAttachment[] = await Promise.all(
            attachments.map(async (file): Promise<MessageAttachment> => {
              const v = await uploadAsset(supabase, { file, userId: user.id, projectId: null });
              return {
                assetId: v.id,
                kind: v.kind,
                name: file.name,
                mimeType: v.mimeType,
                thumbnailUrl: v.thumbnailUrl ?? undefined,
              };
            }),
          );
          formData.set('attachments', JSON.stringify(refs));
        }
      } catch (err) {
        setSubmitting(false);
        setError(err instanceof Error ? err.message : '附件上传失败，请重试');
        return;
      }
    }

    // 在 try/catch 之外调用，避免捕获服务端动作的重定向信号
    await createProjectAction(formData);
  };

  return (
    <form
      onSubmit={onSubmit}
      className="glass mx-auto flex w-full max-w-3xl flex-col gap-4 rounded-3xl p-3 shadow-float"
    >
      {/* 隐藏字段：把本地草稿与所选模型随表单提交到服务端动作 */}
      <input type="hidden" name="prompt" value={prompt} />
      <input type="hidden" name="modelKey" value={modelKey} />
      <input type="hidden" name="clientRequestId" value={requestId} />

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
            {/* 发送：提交表单；prompt 为空或提交中时禁用，提交中展示转圈 */}
            <button
              type="submit"
              disabled={!canSubmit || submitting}
              aria-label={t('home.send')}
              title={t('home.send')}
              className={cn(
                'inline-flex size-9 items-center justify-center rounded-full transition-colors duration-150',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                canSubmit && !submitting
                  ? 'bg-accent text-accent-foreground shadow-soft hover:bg-accent/90'
                  : 'cursor-not-allowed bg-muted text-muted-foreground',
              )}
            >
              {submitting ? (
                <Loader2 className="size-[18px] animate-spin" />
              ) : (
                <ArrowUp className="size-[18px]" />
              )}
            </button>
          </div>
        </div>
      </div>

      {/* 生成模态与具体模型选择条 */}
      <ModelSelector models={availableModels} modelKey={modelKey} onModelChange={setModelKey} />

      {error ? <p className="px-2 text-center text-sm text-danger">{error}</p> : null}
    </form>
  );
}
