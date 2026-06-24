'use client';

/**
 * 设置对话框（第 04 篇第八节：头像菜单设置入口）。
 *
 * 提供用户可自助维护的设置：显示名称与界面语言。保存时写回 `profiles`（display_name /
 * locale）并同步会话状态库，使界面与下次登录都沿用。
 *
 * @module components/shared/SettingsDialog
 */

import { useEffect, useState } from 'react';
import { useSessionStore, type Locale } from '@/stores/session-store';
import { getBrowserSupabase } from '@/lib/supabase/client';
import { useTranslation } from '@/i18n';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils/cn';

/** 受支持语言及其展示名（保留各自原生写法）。 */
const LOCALE_OPTIONS: ReadonlyArray<{ value: Locale; label: string }> = [
  { value: 'zh-CN', label: '中文' },
  { value: 'en', label: 'English' },
];

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
  const [saving, setSaving] = useState(false);

  // 每次打开以最新档案回填显示名称
  useEffect(() => {
    if (open) setName(profile?.display_name ?? '');
  }, [open, profile?.display_name]);

  const onSave = async () => {
    if (!profile) return;
    setSaving(true);
    const trimmed = name.trim();
    const { error } = await getBrowserSupabase()
      .from('profiles')
      .update({ display_name: trimmed || null, locale })
      .eq('id', profile.id);
    setSaving(false);
    if (error) {
      toastError(error.message);
      return;
    }
    setProfile({ ...profile, display_name: trimmed || null, locale });
    success(t('settings.saved'));
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle className="text-lg font-semibold">{t('settings.title')}</DialogTitle>

        <div className="mt-5 flex flex-col gap-5">
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
