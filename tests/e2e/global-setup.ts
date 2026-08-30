import type { FullConfig } from '@playwright/test';
import {
  E2E_EMAIL,
  E2E_MODEL_KEY,
  E2E_PROVIDER,
  cleanupE2eNamespace,
  createLocalAdmin,
  findE2eUser,
} from './environment';

/** 建立测试用户、Vault 凭据与用户私有 fake model。 */
export default async function globalSetup(_config: FullConfig): Promise<void> {
  const admin = createLocalAdmin();
  let user = await findE2eUser(admin);
  if (!user) {
    const { data, error } = await admin.auth.admin.createUser({
      email: E2E_EMAIL,
      email_confirm: true,
      user_metadata: { display_name: 'NeoCanvas E2E' },
    });
    if (error || !data.user) throw error ?? new Error('创建 E2E 用户失败');
    user = data.user;
  }

  await cleanupE2eNamespace(admin, user.id);

  const { error: credentialError } = await admin.rpc('upsert_provider_credential', {
    p_user_id: user.id,
    p_provider: E2E_PROVIDER,
    p_adapter: 'openai',
    p_label: 'NeoCanvas deterministic E2E',
    p_website_url: null,
    p_base_url: null,
    p_api_key: 'e2e-test-key-not-a-real-credential',
    p_enabled: true,
  });
  if (credentialError) throw credentialError;

  const { error: modelError } = await admin.from('model_catalog').upsert(
    {
      key: E2E_MODEL_KEY,
      display_name: 'NeoCanvas E2E Image',
      provider: E2E_PROVIDER,
      modality: 'image',
      capabilities: {
        imageOperations: [
          'generate',
          'semantic_edit',
          'inpaint',
          'outpaint',
          'remove_background',
          'upscale',
        ],
        aspectRatios: ['1:1'],
        sizes: [{ width: 320, height: 320, label: '320×320' }],
        maxOutputs: 4,
        supportsNegativePrompt: false,
        supportsReferenceImages: true,
        supportsImageToVideo: false,
        supportsSeed: false,
        qualities: [],
        isAsync: false,
        supportsWebhook: false,
        maxInputImages: 2,
        inputFidelityOptions: ['standard', 'high'],
        upscaleFactors: [2, 4],
        supportsTransparentOutput: true,
        maxInputPixels: 16_777_216,
      },
      default_params: {
        providerModel: 'deterministic-v1',
        aspectRatio: '1:1',
        width: 320,
        height: 320,
        count: 1,
      },
      sort_order: -10_000,
      is_active: true,
      user_id: user.id,
    },
    { onConflict: 'key' },
  );
  if (modelError) throw modelError;
}
