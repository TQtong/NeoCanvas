/**
 * 导出栅格化助手（第 06 篇 export-canvas）。
 *
 * 把画布渲染出的 SVG 在 Deno 边缘以纯 WASM 转为 PNG / JPEG / PDF：
 *   - PNG：resvg-wasm 按目标像素宽渲染（等比）。
 *   - JPEG：先 PNG 再以 imagescript 重编码（白底，SVG 已绘白底矩形，无透明）。
 *   - PDF：把 PNG 嵌入单页 PDF（页面尺寸按目标像素，pdf-lib）。
 *
 * WASM 初始化按进程惰性单例，避免每次导出重复加载。
 *
 * @module functions/_shared/raster
 */

import { initWasm, Resvg } from 'https://esm.sh/@resvg/resvg-wasm@2.6.2';
import { PDFDocument } from 'https://esm.sh/pdf-lib@1.17.1';
import { Image } from 'https://deno.land/x/imagescript@1.2.17/mod.ts';

/** resvg WASM 初始化单例。 */
let wasmReady: Promise<void> | null = null;

/** 确保 resvg WASM 已初始化（惰性、单例）。 */
function ensureWasm(): Promise<void> {
  if (!wasmReady) {
    wasmReady = initWasm(fetch('https://unpkg.com/@resvg/resvg-wasm@2.6.2/index_bg.wasm'));
  }
  return wasmReady;
}

/**
 * SVG → PNG（按目标像素宽等比渲染）。
 *
 * @param svg - SVG 文档字符串（应含 viewBox）
 * @param pixelWidth - 目标像素宽
 * @returns PNG 字节
 */
export async function svgToPng(svg: string, pixelWidth: number): Promise<Uint8Array> {
  await ensureWasm();
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: Math.max(1, Math.round(pixelWidth)) },
    background: 'white',
  });
  return resvg.render().asPng();
}

/**
 * PNG → JPEG（imagescript 重编码）。
 *
 * @param png - PNG 字节
 * @param quality - JPEG 质量（1..100）
 * @returns JPEG 字节
 */
export async function pngToJpeg(png: Uint8Array, quality = 90): Promise<Uint8Array> {
  const img = await Image.decode(png);
  return await img.encodeJPEG(quality);
}

/**
 * PNG → 单页 PDF（pdf-lib 嵌入，页面尺寸按给定点数）。
 *
 * @param png - PNG 字节
 * @param widthPt - 页面宽（pt）
 * @param heightPt - 页面高（pt）
 * @returns PDF 字节
 */
export async function pngToPdf(png: Uint8Array, widthPt: number, heightPt: number): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([Math.max(1, widthPt), Math.max(1, heightPt)]);
  const image = await pdf.embedPng(png);
  page.drawImage(image, { x: 0, y: 0, width: Math.max(1, widthPt), height: Math.max(1, heightPt) });
  return await pdf.save();
}
