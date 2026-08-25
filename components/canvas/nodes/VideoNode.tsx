'use client';

/**
 * 视频节点（第 04 篇 4.4）。
 *
 * 渲染视频播放器，支持封面帧、自动播放 / 静音 / 循环、播放区间与圆角。媒体经签名 URL
 * （运行时注入的 `data.src`）加载。
 *
 * @module components/canvas/nodes/VideoNode
 */

import { memo, useEffect, useRef } from 'react';
import type { NodeProps } from '@xyflow/react';
import { Film } from 'lucide-react';
import type { VideoNodeData } from '@/types';
import type { CanvasFlowNode } from '@/lib/canvas/node-mapper';
import { Skeleton } from '@/components/ui/skeleton';
import { TransformableNode } from '../TransformableNode';
import { MediaCandidateToggle } from './MediaCandidateToggle';
import { NodeConnectHandles } from './NodeConnectHandles';
import { requestCanvasAssetRefresh } from '@/lib/hooks/use-canvas-media';

function VideoNodeComponent({ id, data, selected }: NodeProps<CanvasFlowNode>) {
  const d = data as VideoNodeData;
  const videoRef = useRef<HTMLVideoElement>(null);

  // 应用播放区间起点
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onLoaded = () => {
      if (d.trimStartMs > 0) video.currentTime = d.trimStartMs / 1000;
    };
    video.addEventListener('loadedmetadata', onLoaded);
    return () => video.removeEventListener('loadedmetadata', onLoaded);
  }, [d.trimStartMs, d.src]);

  return (
    <>
      <TransformableNode id={id} selected={Boolean(selected)} rotation={d.rotation} keepAspectRatio>
        <div
          className="relative size-full overflow-hidden bg-black"
          style={{ borderRadius: d.cornerRadius }}
        >
          {d.mediaRole === 'candidate' ? (
            <div className="absolute left-2 top-2 z-10 rounded-md bg-background/85 px-2 py-1 text-[11px] font-medium text-foreground shadow-soft backdrop-blur">
              候选
            </div>
          ) : null}
          <MediaCandidateToggle targetId={id} collapsed={d.candidatesCollapsed} />
          {d.src ? (
            <video
              ref={videoRef}
              src={d.src}
              poster={d.posterSrc ?? undefined}
              autoPlay={d.autoplay}
              muted={d.muted}
              loop={d.loop}
              controls={Boolean(selected)}
              playsInline
              draggable={false}
              onError={() => {
                if (d.assetId) requestCanvasAssetRefresh(d.assetId);
              }}
              className="size-full select-none object-cover"
            />
          ) : d.assetId ? (
            <Skeleton className="size-full" />
          ) : (
            <div className="flex size-full items-center justify-center text-muted-foreground">
              <Film className="size-8" />
            </div>
          )}
        </div>
      </TransformableNode>
      {/* 连接桩置于内容之后渲染：DOM 靠后 + z-20，确保整圆点在最上层、可拖拽连线 */}
      <NodeConnectHandles selected={Boolean(selected)} />
    </>
  );
}

/** 记忆化视频节点。 */
export const VideoNode = memo(VideoNodeComponent);
