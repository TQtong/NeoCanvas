'use client';

/**
 * 设置对话框（第 04 篇第八节：头像菜单设置入口）。
 *
 * 提供用户可自助维护的设置：显示名称与界面语言。保存时写回 `profiles`（display_name /
 * locale）并同步会话状态库，使界面与下次登录都沿用。
 *
 * @module components/shared/SettingsDialog
 */

import { useEffect, useRef, useState } from 'react';
import { Loader2, Upload, X } from 'lucide-react';
import { useSessionStore, type Locale } from '@/stores/session-store';
import { getBrowserSupabase } from '@/lib/supabase/client';
import { uploadAvatar } from '@/lib/storage/upload';
import { AVATAR_PRESETS, avatarPresetUrl } from '@/lib/avatars';
import { useTranslation } from '@/i18n';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils/cn';
import { Avatar } from './Avatar';

/** 受支持语言及其展示名（保留各自原生写法）。 */
const LOCALE_OPTIONS: ReadonlyArray<{ value: Locale; label: string }> = [
  { value: 'zh-CN', label: '中文' },
  { value: 'en', label: 'English' },
];

/** 头像大小上限（5MB，与 `avatars` 桶的 file_size_limit 一致）。 */
const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

/** {@link SettingsDialog} 属性。 */
export interface SettingsDialogProps {
  /** 是否打开。 */
  open: boolean;
  /** 开关回调。 */
  onOpenChange: (open: boolean) => void;
}

/**
 * 设置对话框组件。
 */
export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const { t } = useTranslation();
  const { success, error: toastError } = useToast();
  const profile = useSessionStore((s) => s.profile);
  const setProfile = useSessionStore((s) => s.setProfile);
  const locale = useSessionStore((s) => s.locale);
  const setLocale = useSessionStore((s) => s.setLocale);

  const [name, setName] = useState(profile?.display_name ?? '');
  const [avatarUrl, setAvatarUrl] = useState<string | null>(profile?.avatar_url ?? null);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 每次打开以最新档案回填显示名称与头像
  useEffect(() => {
    if (open) {
      setName(profile?.display_name ?? '');
      setAvatarUrl(profile?.avatar_url ?? null);
    }
  }, [open, profile?.display_name, profile?.avatar_url]);

  // 选择文件后立即上传到公开 avatars 桶，把返回的公开 URL 作为待保存预览
  const onPickAvatar = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // 复位 input 以便再次选择同一文件也能触发 change
    event.target.value = '';
    if (!file || !profile) return;
    if (!file.type.startsWith('image/')) {
      toastError(t('settings.avatarTypeError'));
      return;
    }
    if (file.size > AVATAR_MAX_BYTES) {
      toastError(t('settings.avatarSizeError'));
      return;
    }
    setUploading(true);
    try {
      const { url } = await uploadAvatar(getBrowserSupabase(), profile.id, file);
      setAvatarUrl(url);
    } catch (err) {
      toastError(err instanceof Error ? err.message : t('settings.avatarTypeError'));
    } finally {
      setUploading(false);
    }
  };

  const onSave = async () => {
    if (!profile) return;
    setSaving(true);
    const trimmed = name.trim();
    const { error } = await getBrowserSupabase()
      .from('profiles')
      .update({ display_name: trimmed || null, avatar_url: avatarUrl, locale })
      .eq('id', profile.id);
    setSaving(false);
    if (error) {
      toastError(error.message);
      return;
    }
    setProfile({ ...profile, display_name: trimmed || null, avatar_url: avatarUrl, locale });
    success(t('settings.saved'));
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle className="text-lg font-semibold">{t('settings.title')}</DialogTitle>

        <div className="mt-5 flex flex-col gap-5">
          <div className="flex flex-col gap-2.5">
            <span className="text-sm text-muted-foreground">{t('settings.avatar')}</span>
            <div className="flex items-center gap-4">
              {/* 头像预览：预设卡通 / 上传图 / 默认卡通（按 user id），由 Avatar 统一兜底 */}
              <div className="relative inline-flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border bg-accent-muted text-xl font-semibold text-accent">
                <Avatar url={avatarUrl} name={name} seed={profile?.id ?? null} />
                {uploading ? (
                  <span className="absolute inset-0 flex items-center justify-center bg-background/60">
                    <Loader2 className="size-5 animate-spin text-accent" />
                  </span>
                ) : null}
              </div>

              <div className="flex flex-col gap-2">
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={uploading}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Upload className="size-4" />
                    {avatarUrl ? t('settings.avatarChange') : t('settings.avatarUpload')}
                  </Button>
                  {avatarUrl ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={uploading}
                      onClick={() => setAvatarUrl(null)}
                    >
                      <X className="size-4" />
                      {t('settings.avatarRemove')}
                    </Button>
                  ) : null}
                </div>
                <span className="text-xs text-muted-foreground">{t('settings.avatarHint')}</span>
              </div>

              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                className="hidden"
                onChange={(e) => void onPickAvatar(e)}
              />
            </div>

            {/* 内置卡通头像：点选即作为待保存头像（存为 preset:<key>） */}
            <span className="mt-1 text-xs text-muted-foreground">{t('settings.avatarPresets')}</span>
            <div className="flex flex-wrap gap-2">
              {AVATAR_PRESETS.map((preset, i) => {
                const url = avatarPresetUrl(preset.key);
                const selected = avatarUrl === url;
                return (
                  <button
                    key={preset.key}
                    type="button"
                    aria-label={t('settings.avatarOption', { n: i + 1 })}
                    aria-pressed={selected}
                    onClick={() => setAvatarUrl(url)}
                    className={cn(
                      'size-10 overflow-hidden rounded-full border-2 transition-colors',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      selected
                        ? 'border-accent'
                        : 'border-transparent hover:border-border',
                    )}
                  >
                    <preset.Component className="size-full" />
                  </button>
                );
              })}
            </div>
          </div>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm text-muted-foreground">{t('settings.displayName')}</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('settings.displayNamePlaceholder')}
              className="h-10 rounded-xl border border-border bg-background px-3 text-sm outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-ring"
            />
          </label>

          <div className="flex flex-col gap-1.5">
            <span className="text-sm text-muted-foreground">{t('settings.language')}</span>
            <div className="flex gap-2">
              {LOCALE_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setLocale(option.value)}
                  className={cn(
                    'h-9 flex-1 rounded-xl border text-sm transition-colors',
                    locale === option.value
                      ? 'border-accent bg-accent-muted text-accent'
                      : 'border-border hover:bg-muted',
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={() => void onSave()} loading={saving}>
              {t('common.save')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
