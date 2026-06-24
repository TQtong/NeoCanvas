/**
 * 导出画布（export-canvas，可选）—— 把当前画布导出为可下载的矢量件（第 06 篇第四节）。
 *
 * 保持轻量：读取画布节点，按选项渲染为一份忠实的 SVG（图片 / 视频以签名 URL 内联、
 * 文本 / 形状 / 手绘 / 画板原生绘制），写入 Storage 后返回短时效签名下载链接。栅格
 * 格式（png/jpeg/pdf）的高保真转换需渲染器，建议在客户端以画布栅格化完成；本函数负责
 * 矢量导出这一服务端可靠产出。
 *
 * @module functions/export-canvas
 */

import { type ExportCanvasRequest } from '../_shared/types.ts';
import { ApiException, exceptionToResponse, fail, handleCorsPreflight, ok } from '../_shared/response.ts';
import { assertProjectOwner, createAdminClient, requireUser, type SupabaseClient } from '../_shared/supabase.ts';
import { pngToJpeg, pngToPdf, svgToPng } from '../_shared/raster.ts';

/** XML 转义。 */
function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

interface NodeRow {
  id: string;
  type: string;
  position_x: number;
  position_y: number;
  width: number | null;
  height: number | null;
  rotation: number;
  z_index: number;
  data: Record<string, unknown>;
  asset_id: string | null;
}

/** 为资产创建签名 URL（导出内联用）。 */
async function signAsset(admin: SupabaseClient, assetId: string): Promise<string | null> {
  const { data: asset } = await admin
    .from('assets')
    .select('storage_bucket, storage_path')
    .eq('id', assetId)
    .maybeSingle();
  if (!asset) return null;
  const { data } = await admin.storage
    .from(asset.storage_bucket)
    .createSignedUrl(asset.storage_path, 3600);
  return data?.signedUrl ?? null;
}

/** 渲染单个节点为 SVG 片段。 */
async function renderNode(admin: SupabaseClient, node: NodeRow): Promise<string> {
  const w = node.width ?? 100;
  const h = node.height ?? 100;
  const transform =
    node.rotation !== 0
      ? ` transform="rotate(${node.rotation} ${node.position_x + w / 2} ${node.position_y + h / 2})"`
      : '';
  const x = node.position_x;
  const y = node.position_y;
  const d = node.data;

  switch (node.type) {
    case 'image':
    case 'video': {
      if (!node.asset_id) return '';
      const url = await signAsset(admin, node.asset_id);
      if (!url) return '';
      const radius = Number(d.cornerRadius ?? 8);
      return `<g${transform}><clipPath id="clip-${node.id}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${radius}"/></clipPath><image href="${esc(url)}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice" clip-path="url(#clip-${node.id})"/></g>`;
    }
    case 'text': {
      const text = String(d.text ?? '');
      const fontSize = Number(d.fontSize ?? 24);
      const color = String(d.color ?? '#1a1a1f');
      const weight = Number(d.fontWeight ?? 500);
      const align = String(d.align ?? 'left');
      const anchor = align === 'center' ? 'middle' : align === 'right' ? 'end' : 'start';
      const tx = align === 'center' ? x + w / 2 : align === 'right' ? x + w : x;
      const lines = text.split('\n');
      const lineHeight = fontSize * Number(d.lineHeight ?? 1.35);
      const tspans = lines
        .map((line, i) => `<tspan x="${tx}" dy="${i === 0 ? fontSize : lineHeight}">${esc(line)}</tspan>`)
        .join('');
      return `<text${transform} y="${y}" font-size="${fontSize}" font-weight="${weight}" fill="${esc(color)}" text-anchor="${anchor}" font-family="sans-serif">${tspans}</text>`;
    }
    case 'shape': {
      const fill = String(d.fill ?? 'none');
      const stroke = String(d.stroke ?? '#000');
      const sw = Number(d.strokeWidth ?? 2);
      const radius = Number(d.cornerRadius ?? 0);
      const kind = String(d.shape ?? 'rectangle');
      if (kind === 'ellipse') {
        return `<ellipse${transform} cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}" fill="${esc(fill)}" stroke="${esc(stroke)}" stroke-width="${sw}"/>`;
      }
      return `<rect${transform} x="${x}" y="${y}" width="${w}" height="${h}" rx="${radius}" fill="${esc(fill)}" stroke="${esc(stroke)}" stroke-width="${sw}"/>`;
    }
    case 'drawing': {
      const path = String(d.path ?? '');
      const stroke = String(d.stroke ?? '#000');
      const sw = Number(d.strokeWidth ?? 3);
      return `<path${transform} transform-origin="0 0" d="${esc(path)}" fill="none" stroke="${esc(stroke)}" stroke-width="${sw}" stroke-linecap="round" transform="translate(${x} ${y})"/>`;
    }
    case 'frame': {
      const bg = String(d.background ?? '#ffffff');
      return `<rect${transform} x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="${esc(bg)}" stroke="#e5e5ea"/>`;
    }
    default:
      return '';
  }
}

Deno.serve(async (request) => {
  const preflight = handleCorsPreflight(request);
  if (preflight) return preflight;
  if (request.method !== 'POST') return fail('invalid_params', '仅支持 POST');

  try {
    const { userId } = await requireUser(request);
    const admin = createAdminClient();
    const body = (await request.json()) as ExportCanvasRequest;
    await assertProjectOwner(admin, body.projectId, userId);

    // 取节点（按选项过滤范围）
    let query = admin
      .from('canvas_nodes')
      .select('id, type, position_x, position_y, width, height, rotation, z_index, data, asset_id')
      .eq('project_id', body.projectId)
      .order('z_index', { ascending: true });
    if (body.options.scope === 'selection' && body.options.nodeIds?.length) {
      query = query.in('id', body.options.nodeIds);
    } else if (body.options.scope === 'frame' && body.options.frameNodeId) {
      query = query.or(`id.eq.${body.options.frameNodeId},parent_id.eq.${body.options.frameNodeId}`);
    }
    const { data: nodes } = await query;
    const rows = (nodes ?? []) as NodeRow[];
    if (rows.length === 0) {
      throw new ApiException('not_found', '画布为空，无可导出内容');
    }

    // 计算包围盒
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of rows) {
      const w = n.width ?? 100;
      const h = n.height ?? 100;
      minX = Math.min(minX, n.position_x);
      minY = Math.min(minY, n.position_y);
      maxX = Math.max(maxX, n.position_x + w);
      maxY = Math.max(maxY, n.position_y + h);
    }
    const pad = 40;
    const vbX = minX - pad;
    const vbY = minY - pad;
    const vbW = maxX - minX + pad * 2;
    const vbH = maxY - minY + pad * 2;

    // 校验格式与倍率
    const format = body.options.format;
    if (!['png', 'jpeg', 'svg', 'pdf'].includes(format)) {
      throw new ApiException('invalid_params', `不支持的导出格式：${format}`);
    }
    const scale = Math.min(4, Math.max(1, Number.isFinite(body.options.scale) ? body.options.scale : 1));

    // 公共中间产物：SVG（viewBox 固定为包围盒；width/height 按用途设置）
    const fragments = await Promise.all(rows.map((n) => renderNode(admin, n)));
    const svgBody =
      `<rect x="${vbX}" y="${vbY}" width="${vbW}" height="${vbH}" fill="#ffffff"/>` +
      fragments.join('') +
      `</svg>`;
    const svgOpen = (w: number, h: number) =>
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vbX} ${vbY} ${vbW} ${vbH}" width="${w}" height="${h}">`;

    const pixelW = Math.max(1, Math.round(vbW * scale));
    const pixelH = Math.max(1, Math.round(vbH * scale));

    // 按格式产出对应件
    let bytes: Uint8Array;
    let ext: string;
    let contentType: string;
    if (format === 'svg') {
      bytes = new TextEncoder().encode(svgOpen(pixelW, pixelH) + svgBody);
      ext = 'svg';
      contentType = 'image/svg+xml';
    } else {
      const png = await svgToPng(svgOpen(vbW, vbH) + svgBody, pixelW);
      if (format === 'png') {
        bytes = png;
        ext = 'png';
        contentType = 'image/png';
      } else if (format === 'jpeg') {
        bytes = await pngToJpeg(png);
        ext = 'jpg';
        contentType = 'image/jpeg';
      } else {
        bytes = await pngToPdf(png, pixelW, pixelH);
        ext = 'pdf';
        contentType = 'application/pdf';
      }
    }

    // 写入 Storage（导出件），扩展名与 MIME 随格式而定
    const exportId = crypto.randomUUID();
    const path = `${userId}/${body.projectId}/exports/${exportId}.${ext}`;
    const { error: uploadError } = await admin.storage
      .from('generations')
      .upload(path, bytes, { contentType, upsert: true });
    if (uploadError) {
      throw new ApiException('internal_error', `导出写入失败：${uploadError.message}`);
    }
    const { data: signed } = await admin.storage.from('generations').createSignedUrl(path, 1800);
    if (!signed?.signedUrl) {
      throw new ApiException('internal_error', '导出签名失败');
    }

    return ok({
      downloadUrl: signed.signedUrl,
      expiresAt: new Date(Date.now() + 1800 * 1000).toISOString(),
      mimeType: contentType,
    });
  } catch (error) {
    return exceptionToResponse(error);
  }
});
