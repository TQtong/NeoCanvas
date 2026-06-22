'use client';

/**
 * 国际化访问入口。
 *
 * 语言偏好存于会话状态库（来自 profiles.locale），此处提供取词函数 `t` 与切换能力，
 * 无须额外 Provider。文案插值以 `{name}` 占位。
 *
 * @module i18n
 */

import { useCallback } from 'react';
import { useSessionStore, type Locale } from '@/stores/session-store';
import { DICTIONARIES, errorMessageKey } from './messages';
import type { ApiClientError } from '@/lib/edge/errors';

/** 插值参数。 */
export type TranslationParams = Record<string, string | number>;

/**
 * 纯函数取词：给定语言、键与参数，返回文案；缺失时回退为键本身。
 *
 * @param locale - 语言
 * @param key - 文案键
 * @param params - 插值参数
 * @returns 文案串
 */
export function translate(locale: Locale, key: string, params?: TranslationParams): string {
  const dict = DICTIONARIES[locale] ?? DICTIONARIES['zh-CN'];
  let text = dict[key] ?? DICTIONARIES['zh-CN'][key] ?? key;
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replace(new RegExp(`\\{${name}\\}`, 'g'), String(value));
    }
  }
  return text;
}

/** useTranslation 返回值。 */
export interface UseTranslation {
  /** 当前语言。 */
  locale: Locale;
  /** 取词函数。 */
  t: (key: string, params?: TranslationParams) => string;
  /** 切换语言（仅本地，持久化由调用方写回 profiles.locale）。 */
  setLocale: (locale: Locale) => void;
  /** 把 ApiClientError 本地化为可展示消息。 */
  tError: (error: ApiClientError) => string;
}

/**
 * 取词 Hook。订阅会话状态库的语言切片。
 *
 * @returns 取词工具
 */
export function useTranslation(): UseTranslation {
  const locale = useSessionStore((s) => s.locale);
  const setLocale = useSessionStore((s) => s.setLocale);

  const t = useCallback(
    (key: string, params?: TranslationParams) => translate(locale, key, params),
    [locale],
  );

  const tError = useCallback(
    (error: ApiClientError) => {
      const localized = translate(locale, errorMessageKey(error.code));
      // 若字典缺该错误码，回退到服务端消息
      return localized === errorMessageKey(error.code) ? error.message : localized;
    },
    [locale],
  );

  return { locale, t, setLocale, tError };
}
