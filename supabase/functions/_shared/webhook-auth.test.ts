import { assertEquals } from 'jsr:@std/assert@1';
import { sha256Hex } from './request-hash.ts';
import {
  parseWebhookTimestamp,
  verifyGenerationWebhookSignature,
  webhookEventKey,
} from './webhook-auth.ts';

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function hmac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return toHex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)));
}

Deno.test('Provider HMAC 必须覆盖时间戳与原始正文并位于重放窗口', async () => {
  const previous = Deno.env.get('GENERATION_WEBHOOK_SECRET_SILICONFLOW');
  Deno.env.set('GENERATION_WEBHOOK_SECRET_SILICONFLOW', 'provider-secret');
  try {
    const now = Date.parse('2026-08-25T08:00:00Z');
    const timestamp = String(Math.floor(now / 1000));
    const rawBody = JSON.stringify({ provider: 'siliconflow', id: 'job-1' });
    const signature = await hmac('provider-secret', `${timestamp}.${rawBody}`);
    const request = new Request('http://localhost/webhook', {
      headers: {
        'x-webhook-timestamp': timestamp,
        'x-webhook-signature': `sha256=${signature}`,
      },
    });
    assertEquals(
      await verifyGenerationWebhookSignature(
        request,
        rawBody,
        {
          provider: 'siliconflow',
          webhookSecretHash: null,
          webhookSecretExpiresAt: null,
        },
        now,
      ),
      { valid: true, timestamp },
    );
    assertEquals(
      (
        await verifyGenerationWebhookSignature(
          request,
          rawBody,
          {
            provider: 'siliconflow',
            webhookSecretHash: null,
            webhookSecretExpiresAt: null,
          },
          now + 6 * 60 * 1000,
        )
      ).valid,
      false,
    );
  } finally {
    if (previous === undefined) Deno.env.delete('GENERATION_WEBHOOK_SECRET_SILICONFLOW');
    else Deno.env.set('GENERATION_WEBHOOK_SECRET_SILICONFLOW', previous);
  }
});

Deno.test('无原生签名 Provider 可使用未过期的任务级 secret', async () => {
  const now = Date.parse('2026-08-25T08:00:00Z');
  const timestamp = new Date(now).toISOString();
  const taskSecret = 'task-secret';
  const request = new Request('http://localhost/webhook', {
    headers: {
      'x-webhook-timestamp': timestamp,
      'x-generation-callback-secret': taskSecret,
    },
  });
  const auth = {
    provider: 'custom:test',
    webhookSecretHash: await sha256Hex(taskSecret),
    webhookSecretExpiresAt: new Date(now + 60_000).toISOString(),
  };
  assertEquals(
    (await verifyGenerationWebhookSignature(request, '{}', auth, now)).valid,
    true,
  );
  assertEquals(
    (
      await verifyGenerationWebhookSignature(
        request,
        '{}',
        { ...auth, webhookSecretExpiresAt: new Date(now - 1).toISOString() },
        now,
      )
    ).valid,
    false,
  );
});

Deno.test('事件键优先使用 Provider event id，否则由签名正文稳定计算', async () => {
  assertEquals(await webhookEventKey('123', '{}', 'event-1'), 'event-1');
  assertEquals(await webhookEventKey('123', '{}'), await webhookEventKey('123', '{}'));
  assertEquals(parseWebhookTimestamp('1787644800'), 1787644800000);
});
