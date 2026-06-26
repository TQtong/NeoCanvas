/**
 * 内置卡通头像集（第 04 篇头像菜单 / 设置）。
 *
 * 头像以**内联 SVG** 渲染，零网络依赖——既不依赖墙外 CDN，也不需打到 Storage，
 * 国内环境必然可显示。用户可在设置中从中挑选；未设头像者按其 user id 稳定分配一个
 * 默认形象（同一用户每次相同），作为「裂图 / 无头像」时的兜底，胜过光秃秃的首字母。
 *
 * 选中的预设以 `preset:<key>` 形式存入 `profiles.avatar_url`（短串、可跨端识别），
 * 与上传得到的 http(s) URL 互不冲突——见 {@link presetKeyFromUrl}。
 *
 * @module lib/avatars
 */

import type { FC } from 'react';

/** 预设头像在 `avatar_url` 中的前缀标识。 */
export const AVATAR_PRESET_PREFIX = 'preset:';

/** 卡通头像 SVG 组件的属性。 */
export interface AvatarSvgProps {
  /** 透传到根 `<svg>` 的类名（一般为 `size-full`）。 */
  className?: string;
}

/** 一个预设卡通头像。 */
export interface AvatarPreset {
  /** 稳定标识（写入 `avatar_url` 的 `preset:` 后缀）。 */
  key: string;
  /** 渲染该形象的 SVG 组件。 */
  Component: FC<AvatarSvgProps>;
}

/** 复用的眼睛：两枚深色圆点加白色高光。 */
function Eyes({ cy = 50, dx = 10, r = 3.6 }: { cy?: number; dx?: number; r?: number }) {
  return (
    <>
      <circle cx={50 - dx} cy={cy} r={r} fill="#2C2622" />
      <circle cx={50 + dx} cy={cy} r={r} fill="#2C2622" />
      <circle cx={50 - dx + 1.1} cy={cy - 1.1} r={r * 0.3} fill="#FFFFFF" />
      <circle cx={50 + dx + 1.1} cy={cy - 1.1} r={r * 0.3} fill="#FFFFFF" />
    </>
  );
}

/** 复用的腮红：两枚半透明粉色圆。 */
function Blush({ cy = 60, dx = 18 }: { cy?: number; dx?: number }) {
  return (
    <>
      <circle cx={50 - dx} cy={cy} r="3.4" fill="#F58CA0" opacity="0.5" />
      <circle cx={50 + dx} cy={cy} r="3.4" fill="#F58CA0" opacity="0.5" />
    </>
  );
}

/** 统一的根 `<svg>` 包装（正方形画布，父容器裁成圆形）。 */
function Svg({ className, children }: AvatarSvgProps & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 100 100"
      className={className}
      role="img"
      aria-hidden="true"
      xmlns="http://www.w3.org/2000/svg"
    >
      {children}
    </svg>
  );
}

/** 橘猫。 */
const CatAvatar: FC<AvatarSvgProps> = ({ className }) => (
  <Svg className={className}>
    <rect width="100" height="100" fill="#FFE3B0" />
    <path d="M26 36 L32 12 L51 30 Z" fill="#F4995A" />
    <path d="M74 36 L68 12 L49 30 Z" fill="#F4995A" />
    <path d="M33 31 L36 20 L45 29 Z" fill="#F8C8A6" />
    <path d="M67 31 L64 20 L55 29 Z" fill="#F8C8A6" />
    <circle cx="50" cy="56" r="27" fill="#F4995A" />
    <ellipse cx="50" cy="64" rx="14" ry="10" fill="#FFF3E4" />
    <Eyes cy={52} dx={11} />
    <path d="M47.4 60 H52.6 L50 62.8 Z" fill="#E0706F" />
    <path d="M50 62.8 V65" stroke="#7A4A36" strokeWidth="1.3" strokeLinecap="round" />
    <path d="M50 65 Q46.5 67.4 43.5 66" stroke="#7A4A36" strokeWidth="1.3" fill="none" strokeLinecap="round" />
    <path d="M50 65 Q53.5 67.4 56.5 66" stroke="#7A4A36" strokeWidth="1.3" fill="none" strokeLinecap="round" />
    <Blush cy={61} dx={20} />
  </Svg>
);

/** 狐狸。 */
const FoxAvatar: FC<AvatarSvgProps> = ({ className }) => (
  <Svg className={className}>
    <rect width="100" height="100" fill="#FFE0D0" />
    <path d="M24 34 L30 12 L48 30 Z" fill="#EF7239" />
    <path d="M76 34 L70 12 L52 30 Z" fill="#EF7239" />
    <path d="M30 30 L32 18 L41 28 Z" fill="#D85E2A" />
    <path d="M70 30 L68 18 L59 28 Z" fill="#D85E2A" />
    <circle cx="50" cy="55" r="27" fill="#F2733B" />
    <path d="M50 45 C41 47 35 58 40 70 C45 78 55 78 60 70 C65 58 59 47 50 45 Z" fill="#FFF4EC" />
    <Eyes cy={50} dx={11} />
    <ellipse cx="50" cy="63" rx="3.2" ry="2.5" fill="#3A2D28" />
    <path d="M50 65.5 V67.5" stroke="#3A2D28" strokeWidth="1.3" strokeLinecap="round" />
    <Blush cy={58} dx={21} />
  </Svg>
);

/** 熊猫。 */
const PandaAvatar: FC<AvatarSvgProps> = ({ className }) => (
  <Svg className={className}>
    <rect width="100" height="100" fill="#ECEEF3" />
    <circle cx="29" cy="27" r="11" fill="#2D2A2E" />
    <circle cx="71" cy="27" r="11" fill="#2D2A2E" />
    <circle cx="50" cy="56" r="27" fill="#FBFCFE" stroke="#E4E6EC" strokeWidth="1" />
    <ellipse cx="39" cy="53" rx="7.5" ry="9.5" fill="#2D2A2E" transform="rotate(-20 39 53)" />
    <ellipse cx="61" cy="53" rx="7.5" ry="9.5" fill="#2D2A2E" transform="rotate(20 61 53)" />
    <circle cx="40" cy="54" r="3.2" fill="#FFFFFF" />
    <circle cx="60" cy="54" r="3.2" fill="#FFFFFF" />
    <circle cx="40.6" cy="54.4" r="1.7" fill="#2D2A2E" />
    <circle cx="59.4" cy="54.4" r="1.7" fill="#2D2A2E" />
    <path d="M46.5 62 H53.5 L50 65.4 Z" fill="#2D2A2E" />
    <path d="M50 65.4 V67.4" stroke="#2D2A2E" strokeWidth="1.3" strokeLinecap="round" />
    <path d="M50 67.4 Q46.5 69.4 43.5 68" stroke="#2D2A2E" strokeWidth="1.3" fill="none" strokeLinecap="round" />
    <path d="M50 67.4 Q53.5 69.4 56.5 68" stroke="#2D2A2E" strokeWidth="1.3" fill="none" strokeLinecap="round" />
  </Svg>
);

/** 小熊。 */
const BearAvatar: FC<AvatarSvgProps> = ({ className }) => (
  <Svg className={className}>
    <rect width="100" height="100" fill="#ECDCC2" />
    <circle cx="30" cy="31" r="11" fill="#B07F4E" />
    <circle cx="70" cy="31" r="11" fill="#B07F4E" />
    <circle cx="30" cy="31" r="5.5" fill="#CFA475" />
    <circle cx="70" cy="31" r="5.5" fill="#CFA475" />
    <circle cx="50" cy="57" r="26" fill="#BE8A57" />
    <ellipse cx="50" cy="65" rx="13" ry="10" fill="#EAD7BD" />
    <Eyes cy={51} dx={10} />
    <ellipse cx="50" cy="61" rx="4" ry="3" fill="#5A3F2A" />
    <path d="M50 64 V66" stroke="#5A3F2A" strokeWidth="1.3" strokeLinecap="round" />
    <path d="M50 66 Q46 68 43.5 66.6" stroke="#5A3F2A" strokeWidth="1.3" fill="none" strokeLinecap="round" />
    <path d="M50 66 Q54 68 56.5 66.6" stroke="#5A3F2A" strokeWidth="1.3" fill="none" strokeLinecap="round" />
    <Blush cy={63} dx={18} />
  </Svg>
);

/** 兔子。 */
const BunnyAvatar: FC<AvatarSvgProps> = ({ className }) => (
  <Svg className={className}>
    <rect width="100" height="100" fill="#FBE0EB" />
    <g transform="rotate(-10 42 30)">
      <ellipse cx="42" cy="24" rx="6" ry="18" fill="#FFFFFF" stroke="#F1D3DE" strokeWidth="1" />
      <ellipse cx="42" cy="24" rx="2.6" ry="12" fill="#F9C2D4" />
    </g>
    <g transform="rotate(10 58 30)">
      <ellipse cx="58" cy="24" rx="6" ry="18" fill="#FFFFFF" stroke="#F1D3DE" strokeWidth="1" />
      <ellipse cx="58" cy="24" rx="2.6" ry="12" fill="#F9C2D4" />
    </g>
    <circle cx="50" cy="58" r="24" fill="#FFFFFF" stroke="#F1D3DE" strokeWidth="1" />
    <Eyes cy={55} dx={9} />
    <path d="M47.8 60 H52.2 L50 62.4 Z" fill="#F19BB3" />
    <path d="M50 62.4 V64" stroke="#E78AA4" strokeWidth="1.2" strokeLinecap="round" />
    <Blush cy={62} dx={16} />
  </Svg>
);

/** 青蛙。 */
const FrogAvatar: FC<AvatarSvgProps> = ({ className }) => (
  <Svg className={className}>
    <rect width="100" height="100" fill="#DCEFC4" />
    <circle cx="50" cy="58" r="26" fill="#7BC468" />
    <circle cx="37" cy="34" r="11" fill="#7BC468" />
    <circle cx="63" cy="34" r="11" fill="#7BC468" />
    <circle cx="37" cy="33" r="6.5" fill="#FFFFFF" />
    <circle cx="63" cy="33" r="6.5" fill="#FFFFFF" />
    <circle cx="37" cy="34" r="3" fill="#2C2622" />
    <circle cx="63" cy="34" r="3" fill="#2C2622" />
    <circle cx="38.1" cy="32.9" r="1" fill="#FFFFFF" />
    <circle cx="64.1" cy="32.9" r="1" fill="#FFFFFF" />
    <circle cx="46" cy="52" r="1" fill="#43803A" />
    <circle cx="54" cy="52" r="1" fill="#43803A" />
    <path d="M35 60 Q50 73 65 60" stroke="#43803A" strokeWidth="2.2" fill="none" strokeLinecap="round" />
    <Blush cy={58} dx={20} />
  </Svg>
);

/** 小鸡。 */
const ChickAvatar: FC<AvatarSvgProps> = ({ className }) => (
  <Svg className={className}>
    <rect width="100" height="100" fill="#FFF1BE" />
    <path d="M44 28 L47 18 L50 27 Z" fill="#F8C53C" />
    <path d="M50 27 L53 17 L56 28 Z" fill="#F8C53C" />
    <circle cx="50" cy="55" r="26" fill="#FBCF4B" />
    <Eyes cy={50} dx={8} />
    <path d="M44 58 H56 L50 54 Z" fill="#F6B43F" />
    <path d="M44 58 H56 L50 64 Z" fill="#F0962E" />
    <Blush cy={58} dx={18} />
  </Svg>
);

/** 企鹅。 */
const PenguinAvatar: FC<AvatarSvgProps> = ({ className }) => (
  <Svg className={className}>
    <rect width="100" height="100" fill="#CFE6F4" />
    <circle cx="50" cy="54" r="27" fill="#36434F" />
    <ellipse cx="50" cy="58" rx="17" ry="19" fill="#F8FAFC" />
    <Eyes cy={49} dx={7} r={3.2} />
    <path d="M45.5 57 H54.5 L50 62 Z" fill="#F2972E" />
    <Blush cy={57} dx={14} />
  </Svg>
);

/**
 * 全部预设头像（顺序即设置中网格的展示顺序）。
 */
export const AVATAR_PRESETS: ReadonlyArray<AvatarPreset> = [
  { key: 'cat', Component: CatAvatar },
  { key: 'fox', Component: FoxAvatar },
  { key: 'panda', Component: PandaAvatar },
  { key: 'bear', Component: BearAvatar },
  { key: 'bunny', Component: BunnyAvatar },
  { key: 'frog', Component: FrogAvatar },
  { key: 'chick', Component: ChickAvatar },
  { key: 'penguin', Component: PenguinAvatar },
];

/** 把预设 key 拼成可存入 `avatar_url` 的标识。 */
export function avatarPresetUrl(key: string): string {
  return `${AVATAR_PRESET_PREFIX}${key}`;
}

/**
 * 从 `avatar_url` 解析预设 key；非预设（如 http URL / 空）返回 null。
 */
export function presetKeyFromUrl(url: string | null | undefined): string | null {
  if (url && url.startsWith(AVATAR_PRESET_PREFIX)) {
    return url.slice(AVATAR_PRESET_PREFIX.length);
  }
  return null;
}

/** 按 key 取预设；未知 key 返回 undefined。 */
export function getAvatarPreset(key: string): AvatarPreset | undefined {
  return AVATAR_PRESETS.find((p) => p.key === key);
}

/** 简单稳定字符串散列（与平台无关，仅用于挑默认头像）。 */
function hashSeed(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) {
    h = (Math.imul(h, 31) + seed.charCodeAt(i)) >>> 0;
  }
  return h;
}

/**
 * 按种子（一般为 user id）稳定挑选一个默认头像：同一种子每次结果相同。
 *
 * @param seed - 决定形象的稳定字符串
 * @returns 对应预设
 */
export function defaultPresetForSeed(seed: string): AvatarPreset {
  const idx = AVATAR_PRESETS.length > 0 ? hashSeed(seed) % AVATAR_PRESETS.length : 0;
  return AVATAR_PRESETS[idx]!;
}
