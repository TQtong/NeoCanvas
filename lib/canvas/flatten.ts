'use client';

/**
 * 分组拍平（flatten）—— 把「底图 + 叠加节点（文字 / 形状 / 手绘）」合成为一张图片
 *（第 04 篇画布连线、第 05 篇生成编排）。
 *
 * 序列视频的关键帧此前只取底图的 `assetId`，海报标题等叠在底图上的独立节点（共享同一
 * `groupId` 的纯逻辑组成员）不会进入帧里——送进视频模型的是「没有文字的光底图」。本模块
 * 在浏览器侧把一个媒体成员与其同组叠层拍平成一张 PNG：用真实字体渲染（含中文，借浏览器
 * 字体引擎而非服务端 resvg，避免 CJK 缺字渲染成空白），从而让「图 + 文字」作为一个整体被
 * 当作一帧分析。
 *
 * 实现要点：构造一份与画布同坐标系（flow 坐标）的 SVG —— 底图以 data URL 内联（避免跨域
 * 污染 canvas）、叠层以原生 SVG 元素绘制（文字用 `<text>`、形状 / 手绘用嵌套 `<svg>` 忠实
 * 复刻各节点组件的渲染）——再经 `<img>` 解码后绘到 canvas，导出为 PNG `File`。
 *
 * 已知取舍：`<text>` 不做自动换行，仅按显式换行符（\n）分行（与服务端导出 export-canvas
 * 的保真度一致）；海报标题多为短行，影响极小。
 *
 * @module lib/canvas/flatten
 */

import type {
  DrawingNodeData,
  ImageFilters,
  ImageNodeData,
  ShapeNodeData,
  TextNodeData,
} from '@/types';
import { pointsToSmoothPath } from './geometry';
import { nodeBox, type CanvasFlowNode } from './node-mapper';

/** 可作为叠层参与拍平的节点类型（媒体成员本身作底图，故不含 image / video）。 */
const OVERLAY_TYPES = new Set<string>(['text', 'shape', 'drawing']);

/** 文本节点内边距（与 {@link components/canvas/nodes/TextNode} 的 `p-1` 一致，4px）。 */
const TEXT_PADDING = 4;

/** 合成图最大像素宽（避免超大 canvas 占用内存）。 */
const MAX_PIXEL_WIDTH = 2048;

/** XML 属性 / 文本转义。 */
function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 收集某媒体成员的「同组叠层」节点：共享同一 `groupId`、类型为文字 / 形状 / 手绘、且与成员
 * 包围盒相交者，按层级（zIndex）升序排列（后绘者在上）。
 *
 * @param nodes - 当前全部节点
 * @param member - 作底图的媒体成员节点
 * @param excludeIds - 需排除的节点 id（如已作描述便签的文字，不应烤进帧里）
 * @returns 叠层节点（绘制顺序）
 */
export function collectGroupOverlays(
  nodes: CanvasFlowNode[],
  member: CanvasFlowNode,
  excludeIds?: Set<string>,
): CanvasFlowNode[] {
  const groupId = member.data.groupId;
  if (!groupId) return [];
  const base = nodeBox(member);
  return nodes
    .filter((n) => {
      if (n.id === member.id) return false;
      if (n.data.groupId !== groupId) return false;
      if (!OVERLAY_TYPES.has(n.data.type)) return false;
      if (excludeIds?.has(n.id)) return false;
      // 空文本不产生可见内容，跳过
      if (n.data.type === 'text' && !(n.data as TextNodeData).text.trim()) return false;
      const b = nodeBox(n);
      // 与底图包围盒相交才纳入（落在底图之外的同组节点会被 viewBox 裁掉，无需绘制）
      return (
        b.x < base.x + base.width &&
        b.x + b.width > base.x &&
        b.y < base.y + base.height &&
        b.y + b.height > base.y
      );
    })
    .sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0));
}

/** 把存储签名 URL 取回并转为 data URL（内联进 SVG，绘到 canvas 不污染、可正常导出）。 */
async function urlToDataUrl(url: string): Promise<string> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`底图拉取失败（${resp.status}）`);
  const blob = await resp.blob();
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('底图编码失败'));
    reader.readAsDataURL(blob);
  });
}

/** 滤镜参数 → CSS filter 函数链（与 {@link components/canvas/nodes/ImageNode} 一致）。 */
function filtersToCss(f: ImageFilters): string {
  return [
    `brightness(${f.brightness})`,
    `contrast(${f.contrast})`,
    `saturate(${f.saturation})`,
    `grayscale(${f.grayscale})`,
    `sepia(${f.sepia})`,
    `blur(${f.blur}px)`,
    `hue-rotate(${f.hueRotate}deg)`,
  ].join(' ');
}

/** 判断滤镜是否为「无调整」恒等态（恒等则不下发 filter，省一次合成开销）。 */
function isIdentityFilters(f: ImageFilters): boolean {
  return (
    f.brightness === 1 &&
    f.contrast === 1 &&
    f.saturation === 1 &&
    f.grayscale === 0 &&
    f.sepia === 0 &&
    f.blur === 0 &&
    f.hueRotate === 0
  );
}

/**
 * 净化字体族串：剔除 `var(--...)` CSS 变量令牌——SVG 经 `<img>` 渲染时处于隔离文档，
 * 取不到页面 CSS 变量，保留它反而可能令整条 font-family 失效。剔除后回退到其余系统字体
 * （含 "Microsoft YaHei" / "PingFang SC" 等中文字体），确保中文正常成字。
 */
function sanitizeFontFamily(family: string): string {
  const cleaned = family
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !/^var\(/i.test(part))
    .join(', ');
  return cleaned || 'sans-serif';
}

/** 旋转包裹：非 0 旋转时以节点中心为轴包一层 `<g transform="rotate(...)">`。 */
function wrapRotation(
  inner: string,
  box: { x: number; y: number; width: number; height: number },
  rotation: number,
): string {
  if (!rotation) return inner;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  return `<g transform="rotate(${rotation} ${cx} ${cy})">${inner}</g>`;
}

/** 底图片段：按 objectFit 映射 preserveAspectRatio，圆角以 clipPath 裁切，叠加滤镜。 */
function imageFragment(
  box: { x: number; y: number; width: number; height: number },
  dataUrl: string,
  d: ImageNodeData,
): string {
  const par =
    d.objectFit === 'contain'
      ? 'xMidYMid meet'
      : d.objectFit === 'fill'
        ? 'none'
        : 'xMidYMid slice';
  const radius = d.cornerRadius ?? 0;
  const clip =
    radius > 0
      ? `<clipPath id="clip-bg"><rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" rx="${radius}"/></clipPath>`
      : '';
  const clipAttr = radius > 0 ? ' clip-path="url(#clip-bg)"' : '';
  const filterAttr = isIdentityFilters(d.filters)
    ? ''
    : ` style="filter:${filtersToCss(d.filters)}"`;
  const image = `<image href="${dataUrl}" x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" preserveAspectRatio="${par}"${clipAttr}${filterAttr} opacity="${d.opacity}"/>`;
  return clip + wrapRotation(image, box, d.rotation);
}

/** 文字片段：忠实复刻 {@link components/canvas/nodes/TextNode} 的排版（内边距 / 对齐 / 行高 / 字重等）。 */
function textFragment(node: CanvasFlowNode): string {
  const d = node.data as TextNodeData;
  const text = d.text ?? '';
  if (!text.trim()) return '';
  const box = nodeBox(node);
  const innerX = box.x + TEXT_PADDING;
  const innerY = box.y + TEXT_PADDING;
  const innerW = box.width - TEXT_PADDING * 2;
  const fontSize = d.fontSize;
  const lineHeightPx = fontSize * d.lineHeight;

  const anchor = d.align === 'center' ? 'middle' : d.align === 'right' ? 'end' : 'start';
  const tx =
    d.align === 'center' ? innerX + innerW / 2 : d.align === 'right' ? innerX + innerW : innerX;

  // 行基线：CSS 块级文本首行顶部留半行距，字形上缘约占字号 0.8（近似 ascent）
  const halfLeading = (lineHeightPx - fontSize) / 2;
  const ascent = fontSize * 0.8;
  const firstBaseline = innerY + halfLeading + ascent;

  const lines = text.split('\n');
  const tspans = lines
    .map(
      (line, i) => `<tspan x="${tx}" y="${firstBaseline + i * lineHeightPx}">${esc(line)}</tspan>`,
    )
    .join('');

  const style =
    `font-family:${sanitizeFontFamily(d.fontFamily)};` +
    `font-size:${fontSize}px;` +
    `font-weight:${d.fontWeight};` +
    `font-style:${d.italic ? 'italic' : 'normal'};` +
    `letter-spacing:${d.letterSpacing}px;`;
  const decoration = d.underline ? ' text-decoration="underline"' : '';
  const inner = `<text fill="${esc(d.color)}" text-anchor="${anchor}"${decoration} style="${style}">${tspans}</text>`;
  return wrapRotation(inner, box, d.rotation);
}

/** 形状描边样式 → SVG dash 数组（与 {@link components/canvas/nodes/ShapeNode} 一致）。 */
function dashArray(style: ShapeNodeData['strokeStyle'], width: number): string {
  if (style === 'dashed') return ` stroke-dasharray="${width * 3} ${width * 2}"`;
  if (style === 'dotted') return ` stroke-dasharray="${width} ${width * 2}"`;
  return '';
}

/** 形状内部元素（局部坐标 0..w / 0..h），忠实复刻 ShapeNode.renderShape。 */
function shapeInner(d: ShapeNodeData, w: number, h: number): string {
  const sw = d.strokeWidth;
  const inset = sw / 2;
  const common = `fill="${esc(d.fill)}" stroke="${esc(d.stroke)}" stroke-width="${sw}"${dashArray(d.strokeStyle, sw)} opacity="${d.opacity}"`;
  switch (d.shape) {
    case 'ellipse':
      return `<ellipse cx="${w / 2}" cy="${h / 2}" rx="${w / 2 - inset}" ry="${h / 2 - inset}" ${common}/>`;
    case 'triangle':
      return `<polygon points="${w / 2},${inset} ${w - inset},${h - inset} ${inset},${h - inset}" stroke-linejoin="round" ${common}/>`;
    case 'diamond':
      return `<polygon points="${w / 2},${inset} ${w - inset},${h / 2} ${w / 2},${h - inset} ${inset},${h / 2}" stroke-linejoin="round" ${common}/>`;
    case 'line':
      return `<line x1="${inset}" y1="${h / 2}" x2="${w - inset}" y2="${h / 2}" stroke="${esc(d.stroke)}" stroke-width="${sw}"${dashArray(d.strokeStyle, sw)} stroke-linecap="round" opacity="${d.opacity}"/>`;
    case 'arrow':
      return (
        `<g opacity="${d.opacity}">` +
        `<line x1="${inset}" y1="${h / 2}" x2="${w - sw * 4}" y2="${h / 2}" stroke="${esc(d.stroke)}" stroke-width="${sw}"${dashArray(d.strokeStyle, sw)} stroke-linecap="round"/>` +
        `<polygon points="${w - inset},${h / 2} ${w - sw * 4},${h / 2 - sw * 2} ${w - sw * 4},${h / 2 + sw * 2}" fill="${esc(d.stroke)}"/>` +
        `</g>`
      );
    case 'rectangle':
    default:
      return `<rect x="${inset}" y="${inset}" width="${Math.max(0, w - sw)}" height="${Math.max(0, h - sw)}" rx="${d.cornerRadius}" ry="${d.cornerRadius}" ${common}/>`;
  }
}

/** 形状片段：以嵌套 `<svg>`（preserveAspectRatio none）在节点框内绘制，复刻 ShapeNode。 */
function shapeFragment(node: CanvasFlowNode): string {
  const d = node.data as ShapeNodeData;
  const box = nodeBox(node);
  const inner = `<svg x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" viewBox="0 0 ${box.width} ${box.height}" preserveAspectRatio="none" overflow="visible">${shapeInner(d, box.width, box.height)}</svg>`;
  return wrapRotation(inner, box, d.rotation);
}

/** 手绘片段：复刻 DrawingNode 的 viewBox（点集包围盒）与路径，嵌套 `<svg>` 自适应到节点框。 */
function drawingFragment(node: CanvasFlowNode): string {
  const d = node.data as DrawingNodeData;
  const box = nodeBox(node);
  const path = d.path || pointsToSmoothPath(d.points, d.smoothing);
  if (!path) return '';

  let viewBox = `0 0 ${box.width} ${box.height}`;
  if (d.points.length > 0) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of d.points) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    const pad = d.strokeWidth;
    viewBox = `${minX - pad} ${minY - pad} ${maxX - minX + pad * 2} ${maxY - minY + pad * 2}`;
  }

  const inner =
    `<svg x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" viewBox="${viewBox}" preserveAspectRatio="none" overflow="visible" opacity="${d.opacity}">` +
    `<path d="${esc(path)}" fill="none" stroke="${esc(d.stroke)}" stroke-width="${d.strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>` +
    `</svg>`;
  return wrapRotation(inner, box, d.rotation);
}

/** 单个叠层节点 → SVG 片段。 */
function overlayFragment(node: CanvasFlowNode): string {
  switch (node.data.type) {
    case 'text':
      return textFragment(node);
    case 'shape':
      return shapeFragment(node);
    case 'drawing':
      return drawingFragment(node);
    default:
      return '';
  }
}

/** SVG 字符串 → PNG Blob（经 `<img>` 解码后绘到离屏 canvas）。 */
async function svgToPngBlob(svg: string, pixelW: number, pixelH: number): Promise<Blob> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();

    const canvas = document.createElement('canvas');
    canvas.width = pixelW;
    canvas.height = pixelH;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建 2D 画布上下文');
    ctx.drawImage(img, 0, 0, pixelW, pixelH);

    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('合成图导出失败'));
      }, 'image/png');
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * 把「媒体成员（底图）+ 其同组叠层」拍平成一张 PNG `File`。
 *
 * @param member - 作底图的图片 / 视频成员节点（需含运行时 `data.src` 签名 URL）
 * @param overlays - 叠层节点（绘制顺序，通常来自 {@link collectGroupOverlays}）
 * @returns 合成 PNG 文件
 * @throws 当底图无可用源、拉取失败或导出失败时
 */
export async function flattenGroupToFile(
  member: CanvasFlowNode,
  overlays: CanvasFlowNode[],
): Promise<File> {
  const d = member.data as ImageNodeData;
  const src = d.src;
  if (!src) throw new Error('成员图片尚无可用媒体源');

  const box = nodeBox(member);
  const bgDataUrl = await urlToDataUrl(src);

  // 输出分辨率：底图原生像素更大时按其等比放大，否则 2 倍，封顶 MAX_PIXEL_WIDTH 防爆内存
  const natW = d.naturalWidth ?? 0;
  const dpr = natW > box.width ? Math.min(4, natW / box.width) : 2;
  const pixelW = Math.min(MAX_PIXEL_WIDTH, Math.max(1, Math.round(box.width * dpr)));
  const pixelH = Math.max(1, Math.round(pixelW * (box.height / box.width)));

  const fragments = [imageFragment(box, bgDataUrl, d), ...overlays.map(overlayFragment)];
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box.x} ${box.y} ${box.width} ${box.height}" width="${pixelW}" height="${pixelH}">` +
    fragments.join('') +
    `</svg>`;

  const blob = await svgToPngBlob(svg, pixelW, pixelH);
  return new File([blob], `frame-${member.id}.png`, { type: 'image/png' });
}
