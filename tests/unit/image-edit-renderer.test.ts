import { describe, expect, it } from 'vitest';
import {
  constrainImageSize,
  convertLuminanceMaskToOpenAIAlpha,
  scaleMaskHistoryForRaster,
} from '@/lib/canvas/image-edit-renderer';
import { buildFlattenSvg, computeFlattenPixelSize } from '@/lib/canvas/flatten';
import { createDefaultNodeData } from '@/lib/canvas/constants';
import type { CanvasFlowNode } from '@/lib/canvas/node-mapper';

/** 构造带裁剪和外观效果的图片节点。 */
function imageNode(): CanvasFlowNode {
  return {
    id: 'image-1',
    type: 'image',
    position: { x: 100, y: 200 },
    width: 600,
    height: 400,
    style: { width: 600, height: 400 },
    data: createDefaultNodeData('image', {
      src: 'https://storage.test/source.png',
      naturalWidth: 6000,
      naturalHeight: 4000,
      crop: { x: 1000, y: 500, width: 3000, height: 2000 },
      rotation: 23,
      opacity: 0.4,
      cornerRadius: 48,
      filters: {
        brightness: 1.1,
        contrast: 0.9,
        saturation: 1.2,
        grayscale: 0,
        sepia: 0,
        blur: 0,
        hueRotate: 0,
      },
    }),
  };
}

describe('高保真图片输入', () => {
  it('按总像素与单边上限计算稳定的等比尺寸', () => {
    expect(constrainImageSize(8000, 4000, 8_000_000)).toEqual({
      width: 4000,
      height: 2000,
      scale: 0.5,
    });
    const edgeLimited = constrainImageSize(8000, 4000, 64_000_000, 3000);
    expect(edgeLimited).toEqual({ width: 3000, height: 1500, scale: 0.375 });
  });

  it('合成尺寸保留裁剪像素密度并遵守模型像素上限', () => {
    const size = computeFlattenPixelSize(imageNode(), {
      maxInputPixels: 2_000_000,
      maxPixelEdge: 8192,
    });
    expect(size.width / size.height).toBeCloseTo(1.5, 3);
    expect(size.width * size.height).toBeLessThanOrEqual(2_005_000);
  });

  it('把白色编辑区转换为透明 Alpha，并保持黑色区域不透明', () => {
    const pixels = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 128, 128, 128, 255]);
    convertLuminanceMaskToOpenAIAlpha(pixels);
    expect(Array.from(pixels)).toEqual([255, 255, 255, 0, 255, 255, 255, 255, 255, 255, 255, 127]);
  });

  it('降采样时在目标像素坐标重放笔画并同步缩放画笔', () => {
    const scaled = scaleMaskHistoryForRaster(
      {
        baseMask: null,
        compactedCommandCount: 0,
        cursor: 1,
        commands: [
          {
            type: 'stroke',
            stroke: {
              id: 'stroke-1',
              tool: 'brush',
              sizePx: 40,
              points: [{ x: 800, y: 400, pressure: 0.5 }],
            },
          },
        ],
      },
      0.5,
      0.5,
    );
    expect(scaled.commands[0]).toMatchObject({
      type: 'stroke',
      stroke: { sizePx: 20, points: [{ x: 400, y: 200, pressure: 0.5 }] },
    });
  });

  it('精准编辑 SVG 应用裁剪和滤镜但不烧录底图旋转、透明度与圆角', () => {
    const node = imageNode();
    const svg = buildFlattenSvg(
      node,
      [],
      'data:image/png;base64,AA==',
      { width: 1500, height: 1000 },
      {
        includeBaseFrameAppearance: false,
      },
    );
    expect(svg).toContain('x="-100"');
    expect(svg).toContain('y="100"');
    expect(svg).toContain('width="1200"');
    expect(svg).toContain('filter:brightness(1.1)');
    expect(svg).not.toContain('rotate(23');
    expect(svg).not.toContain('opacity="0.4"');
    expect(svg).not.toContain('rx="48"');
  });
});
