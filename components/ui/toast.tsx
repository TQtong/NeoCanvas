'use client';

/**
 * 轻量提示条（toast）系统。
 *
 * 提示统一经轻量提示条呈现，避免打断创作（第 04 篇第九节）。以独立 Zustand store
 * 承载提示队列，`useToast` 暴露触发动作，`Toaster` 负责渲染。
 *
 * @module components/ui/toast
 */

import { useEffect } from 'react';
import { create } from 'zustand';
import { CheckCircle2, Info, TriangleAlert, X } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { uuid } from '@/lib/utils/id';

/** 提示类型。 */
export type ToastVariant = 'info' | 'success' | 'error';

/** 一条提示。 */
export interface ToastItem {
  id: string;
  title?: string;
  message: string;
  variant: ToastVariant;
  /** 自动消失时长（毫秒），0 表示不自动消失。 */
  duration: number;
}

interface ToastStore {
  toasts: ToastItem[];
  push: (toast: Omit<ToastItem, 'id'>) => string;
  dismiss: (id: string) => void;
}

const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  push: (toast) => {
    const id = uuid();
    set((state) => ({ toasts: [...state.toasts, { ...toast, id }] }));
    return id;
  },
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
}));

/** useToast 返回值。 */
export interface UseToast {
  toast: (message: string, options?: Partial<Omit<ToastItem, 'id' | 'message'>>) => string;
  success: (message: string, title?: string) => string;
  error: (message: string, title?: string) => string;
  info: (message: string, title?: string) => string;
  dismiss: (id: string) => void;
}

/**
 * 提示钩子。
 *
 * @returns 触发提示的动作集合
 */
export function useToast(): UseToast {
  const push = useToastStore((s) => s.push);
  const dismiss = useToastStore((s) => s.dismiss);

  return {
    toast: (message, options) =>
      push({ message, variant: options?.variant ?? 'info', duration: options?.duration ?? 4000, title: options?.title }),
    success: (message, title) => push({ message, variant: 'success', duration: 3500, title }),
    error: (message, title) => push({ message, variant: 'error', duration: 6000, title }),
    info: (message, title) => push({ message, variant: 'info', duration: 4000, title }),
    dismiss,
  };
}

const VARIANT_ICON = {
  info: Info,
  success: CheckCircle2,
  error: TriangleAlert,
} as const;

const VARIANT_CLASS: Record<ToastVariant, string> = {
  info: 'text-foreground',
  success: 'text-success',
  error: 'text-danger',
};

/** 单条提示的展示与自动消失。 */
function ToastRow({ toast }: { toast: ToastItem }) {
  const dismiss = useToastStore((s) => s.dismiss);
  const Icon = VARIANT_ICON[toast.variant];

  useEffect(() => {
    if (toast.duration <= 0) return;
    const timer = setTimeout(() => dismiss(toast.id), toast.duration);
    return () => clearTimeout(timer);
  }, [toast.id, toast.duration, dismiss]);

  return (
    <div
      role="status"
      className="glass animate-slide-up pointer-events-auto flex w-80 items-start gap-3 rounded-xl px-4 py-3 shadow-float"
    >
      <Icon className={cn('mt-0.5 size-5 shrink-0', VARIANT_CLASS[toast.variant])} />
      <div className="min-w-0 flex-1">
        {toast.title ? <p className="text-sm font-medium">{toast.title}</p> : null}
        <p className="text-sm text-muted-foreground">{toast.message}</p>
      </div>
      <button
        type="button"
        aria-label="关闭提示"
        onClick={() => dismiss(toast.id)}
        className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}

/**
 * 提示渲染容器。在根布局挂载一次。
 */
export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  return (
    <div className="pointer-events-none fixed bottom-6 right-6 z-[100] flex flex-col items-end gap-2">
      {toasts.map((toast) => (
        <ToastRow key={toast.id} toast={toast} />
      ))}
    </div>
  );
}
