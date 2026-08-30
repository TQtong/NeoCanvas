import { assertEquals, assertThrows } from 'jsr:@std/assert@1';
import { applyAlphaMask, inspectRasterImage } from './image.ts';
import { validatePrecisionImageOutput } from './pipeline.ts';
import { ApiException } from './response.ts';
import type { ImageGenerationParams } from './types.ts';

/** 拼接多段字节。 */
function concat(parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

/** 大端 32 位整数。 */
function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

/** 构造检查器所需的 PNG chunk；CRC 不参与元数据解析。 */
function chunk(type: string, data: Uint8Array): Uint8Array {
  return concat([u32(data.length), new TextEncoder().encode(type), data, new Uint8Array(4)]);
}

/** 构造 1×1 RGBA PNG，精确控制 Alpha。 */
async function rgbaPng(alpha: number): Promise<Uint8Array> {
  const ihdr = concat([
    u32(1),
    u32(1),
    new Uint8Array([8, 6, 0, 0, 0]), // 8-bit RGBA、非交错
  ]);
  const raw = new Uint8Array([0, 20, 40, 60, alpha]); // filter=0 + RGBA
  const compressedStream = new Blob([raw])
    .stream()
    .pipeThrough(new CompressionStream('deflate'));
  const compressed = new Uint8Array(await new Response(compressedStream).arrayBuffer());
  return concat([
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', new Uint8Array()),
  ]);
}

Deno.test('PNG 检查器读取真实尺寸并区分透明像素与空 Alpha 通道', async () => {
  assertEquals(await inspectRasterImage(await rgbaPng(64), 'image/png'), {
    width: 1,
    height: 1,
    hasTransparency: true,
  });
  assertEquals(await inspectRasterImage(await rgbaPng(255), 'image/png'), {
    width: 1,
    height: 1,
    hasTransparency: false,
  });
});

Deno.test('主体蒙版按灰度写入源图 Alpha 并保留自然尺寸', async () => {
  const source = await rgbaPng(255);
  const transparentMask = await rgbaPng(0);
  const result = await applyAlphaMask(source, transparentMask);

  assertEquals({ width: result.width, height: result.height }, { width: 1, height: 1 });
  assertEquals(await inspectRasterImage(result.bytes, 'image/png'), {
    width: 1,
    height: 1,
    hasTransparency: true,
  });
});

/** 标准去背景请求。 */
function removeParams(): ImageGenerationParams {
  return {
    modality: 'image',
    operation: 'remove_background',
    inputMode: 'original',
    background: 'transparent',
    count: 1,
    references: [{ origin: 'attachment', assetId: 'source', role: 'content' }],
  };
}

Deno.test('去背景落库门禁拒绝无透明像素或非 PNG 结果', () => {
  validatePrecisionImageOutput(removeParams(), {
    mimeType: 'image/png',
    width: 100,
    height: 100,
    hasTransparency: true,
  });
  const opaque = assertThrows(
    () =>
      validatePrecisionImageOutput(removeParams(), {
        mimeType: 'image/png',
        width: 100,
        height: 100,
        hasTransparency: false,
      }),
    ApiException,
  );
  assertEquals(opaque.details?.reason, 'invalid_transparent_output');
});

Deno.test('高清放大落库门禁验证实际尺寸与请求倍率', () => {
  const params: ImageGenerationParams = {
    modality: 'image',
    operation: 'upscale',
    inputMode: 'original',
    width: 1000,
    height: 500,
    upscaleFactor: 2,
    count: 1,
    references: [{ origin: 'attachment', assetId: 'source', role: 'content' }],
  };
  validatePrecisionImageOutput(params, {
    mimeType: 'image/png',
    width: 2000,
    height: 1000,
    hasTransparency: false,
  });
  const wrongSize = assertThrows(
    () =>
      validatePrecisionImageOutput(params, {
        mimeType: 'image/png',
        width: 1500,
        height: 750,
        hasTransparency: false,
      }),
    ApiException,
  );
  assertEquals(wrongSize.details?.reason, 'invalid_upscale_output');
});
