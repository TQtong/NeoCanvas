'use client';

/**
 * 设置面板共用的轻量表单控件（无独立 UI 库依赖，纯 Tailwind 样式）。
 *
 * 提供：字段包裹（标签 + 提示）、文本/数字输入、复选行、可点选胶囊、开关。供「模型提供商」
 * 与「模型」两个设置子面板复用，保持视觉一致。
 *
 * @module components/shared/settings/controls
 */

import type { InputHTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/utils/cn';

/** 输入框基础样式（与 SettingsDialog 现有输入一致）。 */
const INPUT_CLASS =
  'h-10 w-full rounded-xl border border-border bg-background px-3 text-sm outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-ring';

/** 字段包裹：标签在上，可选提示在下。 */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm text-muted-foreground">{label}</span>
      {children}
      {hint ? <span className="text-xs text-muted-foreground/80">{hint}</span> : null}
    </label>
  );
}

/** 文本输入。 */
export function TextInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(INPUT_CLASS, className)} {...rest} />;
}

/** 数字输入。 */
export function NumberInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input type="number" className={cn(INPUT_CLASS, className)} {...rest} />;
}

/** 复选行：方框 + 文案。 */
export function CheckRow({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="size-4 rounded border-border text-accent focus:ring-ring"
      />
      <span>{label}</span>
    </label>
  );
}

/** 可点选胶囊（用于多选集合，如比例 / 分辨率 / 质量档）。 */
export function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'h-8 rounded-lg border px-2.5 text-xs transition-colors',
        active ? 'border-accent bg-accent-muted text-accent' : 'border-border hover:bg-muted',
      )}
    >
      {children}
    </button>
  );
}

/** 开关（启停）。 */
export function Switch({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        checked ? 'bg-accent' : 'bg-muted',
        disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
      )}
    >
      <span
        className={cn(
          'inline-block size-4 translate-x-0.5 rounded-full bg-background shadow transition-transform',
          checked ? 'translate-x-[1.125rem]' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}
