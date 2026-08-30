import { describe, expect, it } from 'vitest';
import {
  MASK_HISTORY_LIMIT,
  activeMaskCommands,
  appendMaskCommand,
  candidateGeometryForOutput,
  completeMaskCompaction,
  computeImagePreviewTransform,
  createMaskHistory,
  hasMaskContent,
  isValidOutputCanvas,
  outputCanvasForAspectRatio,
  outputCanvasFromInsets,
  outputCanvasToInsets,
  planMaskCompaction,
  previewPointToSource,
  redoMaskCommand,
  sourcePointToPreview,
  undoMaskCommand,
  type MaskCommand,
} from '@/lib/canvas/image-editing';

/** 生成稳定的测试笔画命令。 */
function stroke(id: string): MaskCommand {
  return {
    type: 'stroke',
    stroke: {
      id,
      tool: 'brush',
      sizePx: 24,
      points: [{ x: 10, y: 20, pressure: 1 }],
    },
  };
}

describe('精准图片编辑坐标', () => {
  it('非整数缩放和预览留白下可以精确往返源像素', () => {
    const transform = computeImagePreviewTransform(3000, 2000, 913, 701, 32);
    expect(transform.scale).toBeCloseTo(849 / 3000);
    expect(transform.offsetY).toBeGreaterThan(32);

    const source = previewPointToSource(
      sourcePointToPreview({ x: 1729.25, y: 311.75 }, transform),
      transform,
      0.6,
    );
    expect(source.x).toBeCloseTo(1729.25);
    expect(source.y).toBeCloseTo(311.75);
    expect(source.pressure).toBe(0.6);
  });

  it('指针移出预览后钳制到源图边界且不受 DPR 影响', () => {
    const transform = computeImagePreviewTransform(400, 200, 800, 600);
    expect(previewPointToSource({ x: -10, y: 900 }, transform, 0)).toEqual({
      x: 0,
      y: 200,
      pressure: 1,
    });
  });
});

describe('扩图输出与候选几何', () => {
  it('四边自由扩图可以无损往返 outputCanvas', () => {
    const canvas = outputCanvasFromInsets(1200, 800, {
      top: 100,
      right: 240,
      bottom: 60,
      left: 80,
    });
    expect(canvas).toEqual({
      width: 1520,
      height: 960,
      sourceX: 80,
      sourceY: 100,
      sourceWidth: 1200,
      sourceHeight: 800,
    });
    expect(outputCanvasToInsets(canvas)).toEqual({ top: 100, right: 240, bottom: 60, left: 80 });
    expect(isValidOutputCanvas(canvas)).toBe(true);
  });

  it('七种比例预设都以中心为锚点并完整包含源图', () => {
    for (const ratio of ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3'] as const) {
      const canvas = outputCanvasForAspectRatio(1200, 800, ratio);
      expect(isValidOutputCanvas(canvas)).toBe(true);
      const horizontalRemainder = canvas.width - canvas.sourceWidth - canvas.sourceX;
      const verticalRemainder = canvas.height - canvas.sourceHeight - canvas.sourceY;
      // 奇数个新增像素无法对半分，允许右侧或下侧多 1px。
      expect(Math.abs(canvas.sourceX - horizontalRemainder)).toBeLessThanOrEqual(1);
      expect(Math.abs(canvas.sourceY - verticalRemainder)).toBeLessThanOrEqual(1);
    }
  });

  it('扩图候选保持节点中心和面积并采用输出比例', () => {
    const source = { x: 100, y: 200, width: 480, height: 320 };
    const output = outputCanvasForAspectRatio(1200, 800, '9:16');
    const candidate = candidateGeometryForOutput(source, output);
    expect(candidate.x + candidate.width / 2).toBeCloseTo(340);
    expect(candidate.y + candidate.height / 2).toBeCloseTo(360);
    expect(candidate.width * candidate.height).toBeCloseTo(480 * 320);
    expect(candidate.width / candidate.height).toBeCloseTo(9 / 16);
  });
});

describe('蒙版历史', () => {
  it('清空参与撤销重做，追加新笔画会截断重做分支', () => {
    let history = createMaskHistory();
    history = appendMaskCommand(history, stroke('a'));
    history = appendMaskCommand(history, { type: 'clear', id: 'clear-1' });
    expect(hasMaskContent(history)).toBe(false);
    history = undoMaskCommand(history);
    expect(hasMaskContent(history)).toBe(true);
    history = redoMaskCommand(history);
    expect(hasMaskContent(history)).toBe(false);
    history = undoMaskCommand(history);
    history = appendMaskCommand(history, stroke('b'));
    expect(activeMaskCommands(history).map((command) => command.type)).toEqual([
      'stroke',
      'stroke',
    ]);
    expect(history.commands).toHaveLength(2);
  });

  it('超过 200 条后制定批量压平计划且保留完整像素语义', () => {
    let history = createMaskHistory();
    for (let i = 0; i <= MASK_HISTORY_LIMIT; i += 1) {
      history = appendMaskCommand(history, stroke(String(i)));
    }
    const plan = planMaskCompaction(history);
    expect(plan).not.toBeNull();
    expect(plan?.commandsToCompact).toHaveLength(50);
    expect(plan?.remainingHistory.commands).toHaveLength(151);

    const compacted = completeMaskCompaction(plan!, new Blob(['png'], { type: 'image/png' }));
    expect(compacted.compactedCommandCount).toBe(50);
    expect(compacted.baseMask?.type).toBe('image/png');
    expect(compacted.cursor).toBe(151);
  });
});
