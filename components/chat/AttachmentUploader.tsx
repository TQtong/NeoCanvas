'use client';

/**
 * 附件上传入口（第 04 篇第六节）。
 *
 * 对话输入区左下角的「+」按钮，触发隐藏的文件选择框；选中图片 / 视频后直传到私有桶并在
 * `assets` 登记，成功后把资产作为待发送附件并入对话状态库的 `pendingAttachments`，随消息
 * 一并提交作参考素材。上传期间以转圈替代图标，失败经轻量提示条告知。
 *
 * @module components/chat/AttachmentUploader
 */

import { useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { IconButton } from '@/components/ui/icon-button';
import { Spinner } from '@/components/ui/spinner';
import { useToast } from '@/components/ui/toast';
import { getBrowserSupabase } from '@/lib/supabase/client';
import { uploadAsset } from '@/lib/storage/upload';
import { useChatStore } from '@/stores/chat-store';
import { useSessionStore } from '@/stores/session-store';
import { useTranslation } from '@/i18n';

/** 附件上传入口属性。 */
export interface AttachmentUploaderProps {
  /** 关联项目标识（用于上传路径分桶与资产归属）。 */
  projectId: string;
}

/**
 * 附件上传入口组件。
 *
 * @param props - 见 {@link AttachmentUploaderProps}
 * @returns 「+」附件上传按钮
 */
export function AttachmentUploader({ projectId }: AttachmentUploaderProps) {
  const { t } = useTranslation();
  const toast = useToast();
  // 隐藏的原生文件选择框
  const fileRef = useRef<HTMLInputElement>(null);
  // 上传中标记，期间禁用按钮并显示转圈
  const [uploading, setUploading] = useState(false);

  const addAttachment = useChatStore((s) => s.addAttachment);
  const profile = useSessionStore((s) => s.profile);

  /**
   * 处理选中的文件：直传 → 登记 → 并入待发送附件。
   *
   * @param file - 选中的图片 / 视频文件
   */
  const handleFile = async (file: File) => {
    // 未登录无上传者标识，直接放弃
    if (!profile) return;
    setUploading(true);
    try {
      const asset = await uploadAsset(getBrowserSupabase(), {
        file,
        userId: profile.id,
        projectId,
      });
      addAttachment({
        assetId: asset.id,
        kind: asset.kind,
        name: file.name,
        mimeType: asset.mimeType,
        // 缩略图为运行时签名 URL，可能为空
        thumbnailUrl: asset.thumbnailUrl ?? undefined,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('error.internal_error'));
    } finally {
      setUploading(false);
    }
  };

  return (
    <>
      <IconButton
        size="sm"
        label={t('home.attach')}
        disabled={uploading}
        onClick={() => fileRef.current?.click()}
      >
        {/* 上传中以转圈替代「+」图标 */}
        {uploading ? <Spinner className="size-4" label={t('common.loading')} /> : <Plus />}
      </IconButton>
      <input
        ref={fileRef}
        type="file"
        accept="image/*,video/*"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void handleFile(file);
          // 复位以允许连续选择同一文件
          event.target.value = '';
        }}
      />
    </>
  );
}
