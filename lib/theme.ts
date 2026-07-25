/**
 * 界面主题偏好与 DOM 应用工具。
 *
 * 主题偏好保存在浏览器本地，避免把纯设备级显示偏好写入用户档案。根布局会在首屏绘制前
 * 执行同等逻辑，客户端 Provider 再接管系统主题变化与交互更新。
 *
 * @module lib/theme
 */

/** 主题偏好本地存储键。 */
export const THEME_STORAGE_KEY = 'neocanvas:theme';

/** 用户可选的主题偏好。 */
export const THEME_PREFERENCES = ['system', 'light', 'dark'] as const;

/** 用户主题偏好；system 表示跟随操作系统。 */
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

/** 实际应用到文档的明暗主题。 */
export type ResolvedTheme = Exclude<ThemePreference, 'system'>;

/** 亮色与暗色浏览器主题色。 */
const BROWSER_THEME_COLORS: Readonly<Record<ResolvedTheme, string>> = {
  light: '#fcfcfc',
  dark: '#141419',
};

/**
 * 把任意存储值归一为支持的主题偏好。
 *
 * @param value - 待校验值
 * @returns 合法主题偏好
 */
export function normalizeThemePreference(value: string | null | undefined): ThemePreference {
  return THEME_PREFERENCES.includes(value as ThemePreference)
    ? (value as ThemePreference)
    : 'system';
}

/**
 * 读取本机保存的主题偏好。
 *
 * @returns 已保存主题；不可访问存储时返回 system
 */
export function readStoredThemePreference(): ThemePreference {
  if (typeof window === 'undefined') return 'system';
  try {
    return normalizeThemePreference(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return 'system';
  }
}

/**
 * 解析偏好对应的实际明暗主题。
 *
 * @param preference - 用户主题偏好
 * @returns 当前应使用的明暗主题
 */
export function resolveThemePreference(preference: ThemePreference): ResolvedTheme {
  if (preference !== 'system') return preference;
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * 把主题应用到根文档并同步浏览器主题色。
 *
 * @param preference - 用户主题偏好
 * @returns 实际应用的明暗主题
 */
export function applyThemePreference(preference: ThemePreference): ResolvedTheme {
  const resolved = resolveThemePreference(preference);
  if (typeof document === 'undefined') return resolved;

  document.documentElement.classList.toggle('dark', resolved === 'dark');
  document.documentElement.style.colorScheme = resolved;
  document
    .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    ?.setAttribute('content', BROWSER_THEME_COLORS[resolved]);
  return resolved;
}

/**
 * 保存主题偏好；浏览器禁止存储时仍保持当前会话可切换。
 *
 * @param preference - 用户主题偏好
 */
export function persistThemePreference(preference: ThemePreference): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // 隐私模式或存储被禁用时，仅放弃跨刷新持久化。
  }
}

/**
 * 首屏主题初始化脚本。在 React 与样式内容绘制前恢复偏好，防止暗色用户看到亮色闪烁。
 * 字符串仅包含固定内部常量，不拼接任何用户输入。
 */
export const THEME_INIT_SCRIPT = `(function(){try{var p=localStorage.getItem('${THEME_STORAGE_KEY}');var d=p==='dark'||(p!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches);var e=document.documentElement;e.classList.toggle('dark',d);e.style.colorScheme=d?'dark':'light';}catch(_){}})();`;
