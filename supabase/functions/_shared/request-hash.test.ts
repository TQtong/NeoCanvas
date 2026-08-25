import { assertEquals, assertNotEquals } from 'jsr:@std/assert@1';
import { generationRequestHash } from './request-hash.ts';
import { type UnifiedGenerationRequest } from './types.ts';

function request(): UnifiedGenerationRequest {
  return {
    projectId: 'project-1',
    conversationId: 'conversation-1',
    messageId: 'message-1',
    modality: 'image',
    modelKey: 'test-model',
    prompt: '生成海报',
    params: {
      modality: 'image',
      count: 1,
      aspectRatio: '3:4',
      references: [],
    },
    idempotencyKey: 'request-1',
    placement: { x: 10, y: 20, width: 768, height: 1024 },
    placeholderNodeId: 'placeholder-a',
  };
}

Deno.test('生成请求摘要稳定且排除客户端临时占位 id', async () => {
  const first = request();
  const second = { ...request(), placeholderNodeId: 'placeholder-b' };
  assertEquals(await generationRequestHash(first), await generationRequestHash(second));

  const reordered: UnifiedGenerationRequest = {
    ...request(),
    params: {
      references: [],
      aspectRatio: '3:4',
      count: 1,
      modality: 'image',
    },
  };
  assertEquals(await generationRequestHash(first), await generationRequestHash(reordered));
  assertNotEquals(
    await generationRequestHash(first),
    await generationRequestHash({ ...request(), prompt: '不同请求' }),
  );
});
