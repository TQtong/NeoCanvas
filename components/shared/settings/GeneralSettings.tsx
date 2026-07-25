'use client';

/**
 * 通用设置（头像 / 显示名称 / 界面语言 / 明暗主题）。
 *
 * 由 {@link SettingsDialog} 的「通用」标签承载。保存写回 `profiles`（display_name / avatar_url /
 * locale）并同步会话状态库；保存后不关闭弹层，便于继续切换其它标签。
 *
 * @module components/shared/settings/GeneralSettings
 */

import { useEffect, useRef, useState } from 'react';
import { Loader2, Monitor, Moon, Sun, Upload, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useSessionStore, type Locale, type ThemePreference } from '@/stores/session-store';
import { getBrowserSupabase } from '@/lib/supabase/client';
import { uploadAvatar } from '@/lib/storage/upload';
import { AVATAR_PRESETS, avatarPresetUrl } from '@/lib/avatars';
import { useTranslation } from '@/i18n';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils/cn';
import { Avatar } from '../Avatar';

/** 受支持语言及其展示名（保留各自原生写法）。 */
const LOCALE_OPTIONS: ReadonlyArray<{ value: Locale; label: string }> = [
  { value: 'zh-CN', label: '中文' },
  { value: 'en', label: 'English' },
];

/** 主题偏好及其图标。 */
const THEME_OPTIONS: ReadonlyArray<{
  value: ThemePreference;
  labelKey: string;
  icon: LucideIcon;
}> = [
  { value: 'system', labelKey: 'theme.system', icon: Monitor },
  { value: 'light', labelKey: 'theme.light', icon: Sun },
  { value: 'dark', labelKey: 'theme.dark', icon: Moon },
];

/** 头像大小上限（5MB，与 `avatars` 桶的 file_size_limit 一致）。 */
const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

/**
 * 通用设置面板。
 */
export function GeneralSettings() {
  const { t } = useTranslation();
  const { success, error: toastError } = useToast();
  const profile = useSessionStore((s) => s.profile);
  const setProfile = useSessionStore((s) => s.setProfile);
  const locale = useSessionStore((s) => s.locale);
  const setLocale = useSessionStore((s) => s.setLocale);
  const theme = useSessionStore((s) => s.theme);
  const setTheme = useSessionStore((s) => s.setTheme);

  const [name, setName] = useState(profile?.display_name ?? '');
  const [avatarUrl, setAvatarUrl] = useState<string | null>(profile?.avatar_url ?? null);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 以最新档案回填显示名称与头像
  useEffect(() => {
    setName(profile?.display_name ?? '');
    setAvatarUrl(profile?.avatar_url ?? null);
  }, [profile?.display_name, profile?.avatar_url]);

  // 选择文件后立即上传到公开 avatars 桶，把返回的公开 URL 作为待保存预览
  const onPickAvatar = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = ''; // 复位以便再次选同一文件
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
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2.5">
        <span className="text-sm text-muted-foreground">{t('settings.avatar')}</span>
        <div className="flex items-center gap-4">
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
                  selected ? 'border-accent' : 'border-transparent hover:border-border',
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

      <div className="flex flex-col gap-1.5">
        <span className="text-sm text-muted-foreground">{t('settings.theme')}</span>
        <div className="grid grid-cols-3 gap-2">
          {THEME_OPTIONS.map((option) => {
            const ThemeIcon = option.icon;
            const selected = theme === option.value;
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={selected}
                onClick={() => setTheme(option.value)}
                className={cn(
                  'inline-flex h-10 items-center justify-center gap-2 rounded-xl border text-sm transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  selected
                    ? 'border-accent bg-accent-muted text-accent'
                    : 'border-border hover:bg-muted',
                )}
              >
                <ThemeIcon className="size-4" aria-hidden />
                {t(option.labelKey)}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex justify-end pt-1">
        <Button onClick={() => void onSave()} loading={saving}>
          {t('common.save')}
        </Button>
      </div>
    </div>
  );
}
