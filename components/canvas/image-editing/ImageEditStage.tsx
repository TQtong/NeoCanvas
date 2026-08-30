'use client';

/**
 * 精准图片编辑舞台。
 *
 * 图片始终按输入像素等比显示；局部重绘将 Pointer Event 转成源像素笔画，扩图则显示输出
 * 画布和四边拖动手柄。组件只重绘自身 Canvas，不触碰 React Flow 节点列表。
 *
 * @module components/canvas/image-editing/ImageEditStage
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import type { OutputCanvas } from '@/types';
import {
  computeImagePreviewTransform,
  outputCanvasToInsets,
  previewPointToSource,
  type MaskCommand,
  type MaskHistory,
  type MaskStroke,
  type MaskTool,
  type OutpaintInsets,
} from '@/lib/canvas/image-editing';
import { uuid } from '@/lib/utils/id';
import { useTranslation } from '@/i18n';

/** 编辑舞台属性。 */
export interface ImageEditStageProps {
  src: string;
  sourceWidth: number;
  sourceHeight: number;
  operation: 'semantic_edit' | 'inpaint' | 'outpaint' | 'remove_background' | 'upscale';
  maskHistory: MaskHistory;
  maskTool: MaskTool;
  brushSizePx: number;
  maskVisible: boolean;
  outputCanvas: OutputCanvas;
  disabled?: boolean;
  onStroke: (stroke: MaskStroke) => void;
  onOutpaintInsetsChange: (insets: OutpaintInsets) => void;
}

const MASK_COLOR = 'rgba(236, 72, 153, 0.62)';

/** 绘制一条蒙版预览笔画。 */
function drawPreviewStroke(context: CanvasRenderingContext2D, stroke: MaskStroke): void {
  if (stroke.points.length === 0) return;
  context.save();
  context.globalCompositeOperation = stroke.tool === 'brush' ? 'source-over' : 'destination-out';
  context.strokeStyle = MASK_COLOR;
  context.fillStyle = MASK_COLOR;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  if (stroke.points.length === 1) {
    const point = stroke.points[0]!;
    context.beginPath();
    context.arc(
      point.x,
      point.y,
      Math.max(0.5, (stroke.sizePx * point.pressure) / 2),
      0,
      Math.PI * 2,
    );
    context.fill();
  } else {
    for (let index = 1; index < stroke.points.length; index += 1) {
      const previous = stroke.points[index - 1]!;
      const current = stroke.points[index]!;
      context.lineWidth = Math.max(1, stroke.sizePx * ((previous.pressure + current.pressure) / 2));
      context.beginPath();
      context.moveTo(previous.x, previous.y);
      context.lineTo(current.x, current.y);
      context.stroke();
    }
  }
  context.restore();
}

/** 在透明预览层重放尾部命令。 */
function replayPreviewCommands(
  context: CanvasRenderingContext2D,
  commands: MaskCommand[],
  width: number,
  height: number,
): void {
  for (const command of commands) {
    if (command.type === 'clear') context.clearRect(0, 0, width, height);
    else drawPreviewStroke(context, command.stroke);
  }
}

/** 把黑底白区基础蒙版转换成粉色透明预览。 */
async function drawBasePreview(
  context: CanvasRenderingContext2D,
  baseMask: Blob,
  width: number,
  height: number,
): Promise<void> {
  const url = URL.createObjectURL(baseMask);
  try {
    const image = new Image();
    image.decoding = 'async';
    image.src = url;
    await image.decode();
    const scratch = document.createElement('canvas');
    scratch.width = width;
    scratch.height = height;
    const scratchContext = scratch.getContext('2d');
    if (!scratchContext) throw new Error('无法创建蒙版预览上下文');
    scratchContext.drawImage(image, 0, 0, width, height);
    const pixels = scratchContext.getImageData(0, 0, width, height);
    const red = 236;
    const green = 72;
    const blue = 153;
    for (let index = 0; index < pixels.data.length; index += 4) {
      const luminance = pixels.data[index]!;
      pixels.data[index] = red;
      pixels.data[index + 1] = green;
      pixels.data[index + 2] = blue;
      pixels.data[index + 3] = Math.round(luminance * 0.62);
    }
    scratchContext.putImageData(pixels, 0, 0);
    context.drawImage(scratch, 0, 0);
    scratch.width = 1;
    scratch.height = 1;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 四边扩图拖动方向。 */
type OutpaintSide = keyof OutpaintInsets;

/** 扩图边框与四边拖动手柄。 */
function OutpaintFrame({
  scale,
  insets,
  disabled,
  onChange,
}: {
  scale: number;
  insets: OutpaintInsets;
  disabled: boolean;
  onChange: (insets: OutpaintInsets) => void;
}) {
  const { t } = useTranslation();
  const dragRef = useRef<{
    side: OutpaintSide;
    startX: number;
    startY: number;
    initial: OutpaintInsets;
  } | null>(null);
  const start = (side: OutpaintSide, event: PointerEvent<HTMLButtonElement>) => {
    if (disabled) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      side,
      startX: event.clientX,
      startY: event.clientY,
      initial: insets,
    };
  };
  const move = (event: PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = (event.clientX - drag.startX) / scale;
    const dy = (event.clientY - drag.startY) / scale;
    const next = { ...drag.initial };
    if (drag.side === 'left') next.left = Math.max(0, Math.round(drag.initial.left - dx));
    if (drag.side === 'right') next.right = Math.max(0, Math.round(drag.initial.right + dx));
    if (drag.side === 'top') next.top = Math.max(0, Math.round(drag.initial.top - dy));
    if (drag.side === 'bottom') next.bottom = Math.max(0, Math.round(drag.initial.bottom + dy));
    onChange(next);
  };
  const end = (event: PointerEvent<HTMLButtonElement>) => {
    if (dragRef.current) event.currentTarget.releasePointerCapture(event.pointerId);
    dragRef.current = null;
  };
  const shared = {
    type: 'button' as const,
    disabled,
    onPointerMove: move,
    onPointerUp: end,
    onPointerCancel: end,
  };
  return (
    <>
      <button
        {...shared}
        aria-label={t('imageEdit.drag.top')}
        className="absolute -top-2 left-8 right-8 h-4 cursor-ns-resize rounded-full border border-accent bg-background/90 shadow-soft"
        onPointerDown={(event) => start('top', event)}
      />
      <button
        {...shared}
        aria-label={t('imageEdit.drag.right')}
        className="absolute -right-2 bottom-8 top-8 w-4 cursor-ew-resize rounded-full border border-accent bg-background/90 shadow-soft"
        onPointerDown={(event) => start('right', event)}
      />
      <button
        {...shared}
        aria-label={t('imageEdit.drag.bottom')}
        className="absolute -bottom-2 left-8 right-8 h-4 cursor-ns-resize rounded-full border border-accent bg-background/90 shadow-soft"
        onPointerDown={(event) => start('bottom', event)}
      />
      <button
        {...shared}
        aria-label={t('imageEdit.drag.left')}
        className="absolute -left-2 bottom-8 top-8 w-4 cursor-ew-resize rounded-full border border-accent bg-background/90 shadow-soft"
        onPointerDown={(event) => start('left', event)}
      />
    </>
  );
}

/** 图片编辑舞台。 */
export function ImageEditStage(props: ImageEditStageProps) {
  const { t } = useTranslation();
  const viewportRef = useRef<HTMLDivElement>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement>(null);
  // 首次 ResizeObserver 回调前使用安全尺寸，避免 padding 令可用区域成为负数。
  const [viewportSize, setViewportSize] = useState({ width: 800, height: 600 });
  const [currentStroke, setCurrentStroke] = useState<MaskStroke | null>(null);
  const currentStrokeRef = useRef<MaskStroke | null>(null);
  const isOutpaint = props.operation === 'outpaint';
  const previewWidth = isOutpaint ? props.outputCanvas.width : props.sourceWidth;
  const previewHeight = isOutpaint ? props.outputCanvas.height : props.sourceHeight;
  const transform = useMemo(
    () =>
      computeImagePreviewTransform(
        previewWidth,
        previewHeight,
        viewportSize.width,
        viewportSize.height,
        36,
      ),
    [previewHeight, previewWidth, viewportSize.height, viewportSize.width],
  );

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      setViewportSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = maskCanvasRef.current;
    if (!canvas || props.operation !== 'inpaint') return;
    canvas.width = props.sourceWidth;
    canvas.height = props.sourceHeight;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    let cancelled = false;
    void (async () => {
      if (props.maskHistory.baseMask) {
        await drawBasePreview(
          context,
          props.maskHistory.baseMask,
          props.sourceWidth,
          props.sourceHeight,
        );
      }
      if (cancelled) return;
      replayPreviewCommands(
        context,
        props.maskHistory.commands.slice(0, props.maskHistory.cursor),
        props.sourceWidth,
        props.sourceHeight,
      );
      if (currentStroke) drawPreviewStroke(context, currentStroke);
    })();
    return () => {
      cancelled = true;
    };
  }, [currentStroke, props.maskHistory, props.operation, props.sourceHeight, props.sourceWidth]);

  const pointFromEvent = useCallback(
    (event: PointerEvent<HTMLCanvasElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      return previewPointToSource(
        { x: event.clientX - rect.left, y: event.clientY - rect.top },
        {
          offsetX: 0,
          offsetY: 0,
          scale: rect.width / props.sourceWidth,
          displayWidth: rect.width,
          displayHeight: rect.height,
          sourceWidth: props.sourceWidth,
          sourceHeight: props.sourceHeight,
        },
        event.pressure || 1,
      );
    },
    [props.sourceHeight, props.sourceWidth],
  );

  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    if (props.disabled || props.operation !== 'inpaint' || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const stroke: MaskStroke = {
      id: uuid(),
      tool: props.maskTool,
      sizePx: props.brushSizePx,
      points: [pointFromEvent(event)],
    };
    currentStrokeRef.current = stroke;
    setCurrentStroke(stroke);
  };
  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    const stroke = currentStrokeRef.current;
    if (!stroke || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const point = pointFromEvent(event);
    const previous = stroke.points[stroke.points.length - 1]!;
    if (Math.hypot(point.x - previous.x, point.y - previous.y) < 0.5) return;
    const next = { ...stroke, points: [...stroke.points, point] };
    currentStrokeRef.current = next;
    setCurrentStroke(next);
  };
  const finishStroke = (event: PointerEvent<HTMLCanvasElement>) => {
    const stroke = currentStrokeRef.current;
    if (!stroke) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    currentStrokeRef.current = null;
    setCurrentStroke(null);
    props.onStroke(stroke);
  };

  /** 键盘用户按空格在源图中心落一个当前工具笔触，再由 Ctrl/Cmd+Z 撤销。 */
  const paintFromKeyboard = (event: KeyboardEvent<HTMLCanvasElement>) => {
    if (props.disabled || props.operation !== 'inpaint' || event.key !== ' ') return;
    event.preventDefault();
    event.stopPropagation();
    props.onStroke({
      id: uuid(),
      tool: props.maskTool,
      sizePx: props.brushSizePx,
      points: [{ x: props.sourceWidth / 2, y: props.sourceHeight / 2, pressure: 1 }],
    });
  };

  const sourceLeft =
    transform.offsetX + (isOutpaint ? props.outputCanvas.sourceX * transform.scale : 0);
  const sourceTop =
    transform.offsetY + (isOutpaint ? props.outputCanvas.sourceY * transform.scale : 0);
  const sourceDisplayWidth = props.sourceWidth * transform.scale;
  const sourceDisplayHeight = props.sourceHeight * transform.scale;
  const outputInsets = outputCanvasToInsets(props.outputCanvas);

  return (
    <div
      ref={viewportRef}
      className="relative size-full min-h-0 overflow-hidden rounded-xl border border-border bg-muted/40"
      style={{
        backgroundImage:
          'linear-gradient(45deg,hsl(var(--border)/.55) 25%,transparent 25%),linear-gradient(-45deg,hsl(var(--border)/.55) 25%,transparent 25%),linear-gradient(45deg,transparent 75%,hsl(var(--border)/.55) 75%),linear-gradient(-45deg,transparent 75%,hsl(var(--border)/.55) 75%)',
        backgroundPosition: '0 0,0 8px,8px -8px,-8px 0',
        backgroundSize: '16px 16px',
      }}
    >
      {isOutpaint ? (
        <div
          className="absolute border-2 border-dashed border-accent bg-background/35"
          style={{
            left: transform.offsetX,
            top: transform.offsetY,
            width: transform.displayWidth,
            height: transform.displayHeight,
          }}
        >
          <OutpaintFrame
            scale={transform.scale}
            insets={outputInsets}
            disabled={Boolean(props.disabled)}
            onChange={props.onOutpaintInsetsChange}
          />
        </div>
      ) : null}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={props.src}
        alt={t('imageEdit.stageAlt')}
        draggable={false}
        className="absolute select-none object-fill shadow-float"
        style={{
          left: sourceLeft,
          top: sourceTop,
          width: sourceDisplayWidth,
          height: sourceDisplayHeight,
        }}
      />
      {props.operation === 'inpaint' ? (
        <canvas
          ref={maskCanvasRef}
          aria-label={t('imageEdit.maskArea')}
          aria-description={t('imageEdit.maskKeyboardHint')}
          tabIndex={0}
          className="absolute touch-none"
          style={{
            left: sourceLeft,
            top: sourceTop,
            width: sourceDisplayWidth,
            height: sourceDisplayHeight,
            opacity: props.maskVisible ? 1 : 0,
            cursor: props.maskTool === 'brush' ? 'crosshair' : 'cell',
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={finishStroke}
          onPointerCancel={finishStroke}
          onKeyDown={paintFromKeyboard}
        />
      ) : null}
    </div>
  );
}
