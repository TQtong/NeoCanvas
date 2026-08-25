import { assertThrows } from 'jsr:@std/assert@1';
import { requireInternalServiceRole } from './internal-auth.ts';
import { ApiException } from './response.ts';

Deno.test('内部函数只接受精确 service-role Bearer token', () => {
  const previous = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'service-secret');
  try {
    requireInternalServiceRole(
      new Request('http://localhost/internal', {
        headers: { Authorization: 'Bearer service-secret' },
      }),
    );

    for (
      const authorization of [
        '',
        'service-secret',
        'Bearer ordinary-user-jwt',
        'Basic service-secret',
        'Bearer service-secret extra',
      ]
    ) {
      const error = assertThrows(
        () =>
          requireInternalServiceRole(
            new Request('http://localhost/internal', {
              headers: authorization ? { Authorization: authorization } : {},
            }),
          ),
        ApiException,
      );
      if (error.code !== 'internal_auth_required') {
        throw new Error(`意外错误码：${error.code}`);
      }
    }
  } finally {
    if (previous === undefined) Deno.env.delete('SUPABASE_SERVICE_ROLE_KEY');
    else Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', previous);
  }
});
