'use client';

/**
 * 设置对话框（第 04 篇第八节：头像菜单设置入口）。
 *
 * 以标签页组织两类设置：
 *   · 通用 —— 头像 / 显示名称 / 界面语言（{@link GeneralSettings}）；
 *   · 模型提供商 —— 按提供商进入的 BYOK 凭证配置（{@link ProviderSettings}）。
 *
 * @module components/shared/SettingsDialog
 */

import { useState } from 'react';
import { useTranslation } from '@/i18n';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils/cn';
import { GeneralSettings } from './settings/GeneralSettings';
import { ProviderSettings } from './settings/ProviderSettings';

/** {@link SettingsDialog} 属性。 */
export interface SettingsDialogProps {
  /** 是否打开。 */
  open: boolean;
  /** 开关回调。 */
  onOpenChange: (open: boolean) => void;
  /** 从业务恢复入口打开时可以直接定位到对应标签。 */
  initialTab?: SettingsTab;
}

/** 设置标签。 */
type SettingsTab = 'general' | 'providers';

/**
 * 设置对话框组件。
 */
export function SettingsDialog({
  open,
  onOpenChange,
  initialTab = 'general',
}: SettingsDialogProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<SettingsTab>(initialTab);

  const tabs: ReadonlyArray<{ id: SettingsTab; label: string }> = [
    { id: 'general', label: t('settings.tabGeneral') },
    { id: 'providers', label: t('settings.tabProviders') },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(94vw,54rem)]">
        <DialogTitle className="text-lg font-semibold">{t('settings.title')}</DialogTitle>

        <div className="mt-4 flex gap-1 border-b border-border">
          {tabs.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={cn(
                'relative -mb-px border-b-2 px-3 py-2 text-sm transition-colors',
                tab === item.id
                  ? 'border-accent text-accent'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="mt-5 max-h-[68vh] overflow-y-auto pr-1">
          {tab === 'general' ? <GeneralSettings /> : null}
          {tab === 'providers' ? <ProviderSettings /> : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
