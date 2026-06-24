'use client';

/**
 * 图片节点（第 04 篇 4.4）。
 *
 * 渲染一张图片，支持裁剪、滤镜、圆角、透明度等展示属性；媒体经签名 URL（运行时注入
 * 的 `data.src`）加载，未就绪时显示骨架，未绑定资产时显示占位。
 *
 * @module components/canvas/nodes/ImageNode
 */

import { memo, useEffect, useState } from 'react';
import type { NodeProps } from '@xyflow/react';
import { ImageOff } from 'lucide-react';
import type { ImageFilters, ImageNodeData } from '@/types';
import type { CanvasFlowNode } from '@/lib/canvas/node-mapper';
import { Skeleton } from '@/components/ui/skeleton';
import { TransformableNode } from '../TransformableNode';

/** 把滤镜参数序列化为 CSS filter 函数链。 */
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

/** 计算裁剪样式：将裁剪区域映射填满容器（基于原始像素与裁剪框）。 */
function cropStyle(data: ImageNodeData): React.CSSProperties {
  const { crop, naturalWidth, naturalHeight, objectFit } = data;
  if (!crop || !naturalWidth || !naturalHeight) {
    return { width: '100%', height: '100%', objectFit };
  }
  return {
    position: 'absolute',
    width: `${(naturalWidth / crop.width) * 100}%`,
    height: `${(naturalHeight / crop.height) * 100}%`,
    left: `${-(crop.x / crop.width) * 100}%`,
    top: `${-(crop.y / crop.height) * 100}%`,
    maxWidth: 'none',
    objectFit: 'fill',
  };
}

function ImageNodeComponent({ id, data, selected }: NodeProps<CanvasFlowNode>) {
  const d = data as ImageNodeData;
  // 渐进加载：原图 onLoad 前以模糊缩略图垫底；媒体源切换（占位转化 / 替换）时重置
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    setLoaded(false);
  }, [d.src]);

  return (
    <TransformableNode id={id} selected={Boolean(selected)} rotation={d.rotation} keepAspectRatio>
      <div
        className="relative size-full overflow-hidden bg-muted/40"
        style={{ borderRadius: d.cornerRadius, opacity: d.opacity }}
      >
        {d.src ? (
          <>
            {/* 缩略图占位层：原图就绪前以模糊缩略图先行呈现，提升大图加载观感 */}
            {d.thumbnailSrc && !loaded ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={d.thumbnailSrc}
                alt=""
                aria-hidden
                draggable={false}
                className="absolute inset-0 select-none"
                style={{ ...cropStyle(d), filter: `${filtersToCss(d.filters)} blur(12px)`, transform: 'scale(1.06)' }}
              />
            ) : null}
            {/* 原图：经签名 URL 加载，禁用 next/image（已由 Storage 变换处理）；加载完成淡入 */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={d.src}
              alt={d.alt}
              draggable={false}
              onLoad={() => setLoaded(true)}
              className="absolute inset-0 select-none transition-opacity duration-300"
              style={{ ...cropStyle(d), filter: filtersToCss(d.filters), opacity: loaded ? 1 : 0 }}
            />
            {/* 无缩略图且原图未就绪时退回骨架 */}
            {!loaded && !d.thumbnailSrc ? <Skeleton className="absolute inset-0 size-full" /> : null}
          </>
        ) : d.assetId ? (
          <Skeleton className="size-full" />
        ) : (
          <div className="flex size-full flex-col items-center justify-center gap-2 text-muted-foreground">
            <ImageOff className="size-8" />
          </div>
        )}
      </div>
    </TransformableNode>
  );
}

/** 记忆化图片节点。 */
export const ImageNode = memo(ImageNodeComponent);
