'use client';

/**
 * 模型提供商凭证设置（BYOK）。
 *
 * 列出全部受支持的提供商，每项可填写 API Key（写时遮罩、保存后仅显示尾号）、可选自定义端点，
 * 并支持连通性测试、启停与删除。明文 Key 经 `provider-credentials` 边缘函数写入 Vault，
 * 永不回流前端。
 *
 * @module components/shared/settings/ProviderSettings
 */

import { useState } from 'react';
import { Check, Loader2, Trash2, X } from 'lucide-react';
import type { Provider, ProviderCredential } from '@/types';
import { PROVIDERS } from '@/types';
import { useTranslation } from '@/i18n';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import {
  useProviderCredentials,
  type UseProviderCredentials,
} from '@/lib/hooks/use-provider-credentials';
import { Field, Switch, TextInput } from './controls';

/** 提供商品牌名（品牌名不本地化）。 */
const PROVIDER_LABELS: Record<Provider, string> = {
  openai: 'OpenAI',
  google: 'Google Gemini',
  volcengine: '火山方舟 Ark',
  fal: 'fal.ai',
  replicate: 'Replicate',
  siliconflow: '硅基流动 SiliconFlow',
};

/**
 * 模型提供商设置面板。
 */
export function ProviderSettings() {
  const { t } = useTranslation();
  const api = useProviderCredentials();
  const byProvider = new Map(api.credentials.map((c) => [c.provider, c]));

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">{t('providers.intro')}</p>
      {api.loading ? (
        <div className="flex justify-center py-8 text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {PROVIDERS.map((provider) => (
            <ProviderRow
              key={provider}
              provider={provider}
              credential={byProvider.get(provider)}
              api={api}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** 单个提供商的配置行。 */
function ProviderRow({
  provider,
  credential,
  api,
}: {
  provider: Provider;
  credential: ProviderCredential | undefined;
  api: UseProviderCredentials;
}) {
  const { t } = useTranslation();
  const { success, error: toastError } = useToast();
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(credential?.baseUrl ?? '');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testOk, setTestOk] = useState<boolean | null>(null);
  const [testMsg, setTestMsg] = useState<string | null>(null);

  const configured = Boolean(credential);

  const onSave = async () => {
    if (!configured && !apiKey.trim()) {
      toastError(t('providers.keyRequired'));
      return;
    }
    setSaving(true);
    try {
      await api.saveCredential({
        provider,
        apiKey: apiKey.trim() || undefined,
        baseUrl: baseUrl.trim() || null,
      });
      setApiKey('');
      setTestOk(null);
      setTestMsg(null);
      success(t('providers.saved'));
    } catch (err) {
      toastError(err instanceof Error ? err.message : t('providers.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const onTest = async () => {
    setTesting(true);
    setTestOk(null);
    setTestMsg(null);
    try {
      const result = await api.testCredential({
        provider,
        apiKey: apiKey.trim() || undefined,
        baseUrl: baseUrl.trim() || null,
      });
      setTestOk(result.ok);
      setTestMsg(result.ok ? t('providers.testOk') : result.message ?? t('providers.testFailed'));
    } catch (err) {
      setTestOk(false);
      setTestMsg(err instanceof Error ? err.message : t('providers.testFailed'));
    } finally {
      setTesting(false);
    }
  };

  const onToggle = async (next: boolean) => {
    try {
      await api.toggleCredential(provider, next);
    } catch (err) {
      toastError(err instanceof Error ? err.message : t('providers.saveFailed'));
    }
  };

  const onDelete = async () => {
    if (!credential) return;
    try {
      await api.deleteCredential(credential.id);
      setBaseUrl('');
      success(t('providers.deleted'));
    } catch (err) {
      toastError(err instanceof Error ? err.message : t('providers.saveFailed'));
    }
  };

  return (
    <div className="rounded-xl border border-border p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{PROVIDER_LABELS[provider]}</span>
          {configured ? (
            <span className="rounded-md bg-accent-muted px-1.5 py-0.5 text-xs text-accent">
              ••••{credential!.keyLast4}
            </span>
          ) : (
            <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
              {t('providers.notConfigured')}
            </span>
          )}
        </div>
        {configured ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {credential!.enabled ? t('providers.enabled') : t('providers.disabled')}
            </span>
            <Switch checked={credential!.enabled} onChange={(n) => void onToggle(n)} />
            <button
              type="button"
              aria-label={t('common.delete')}
              onClick={() => void onDelete()}
              className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-danger/10 hover:text-danger"
            >
              <Trash2 className="size-4" />
            </button>
          </div>
        ) : null}
      </div>

      <div className="mt-3 flex flex-col gap-3">
        <Field
          label={t('providers.apiKey')}
          hint={configured ? t('providers.keyHintConfigured') : t('providers.keyHintNew')}
        >
          <TextInput
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={configured ? t('providers.keyPlaceholderConfigured') : t('providers.keyPlaceholder')}
          />
        </Field>
        <Field label={t('providers.baseUrl')} hint={t('providers.baseUrlHint')}>
          <TextInput
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={t('providers.baseUrlPlaceholder')}
          />
        </Field>

        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void onTest()} loading={testing}>
            {t('providers.test')}
          </Button>
          <Button size="sm" onClick={() => void onSave()} loading={saving}>
            {t('common.save')}
          </Button>
          {testOk != null ? (
            <span
              className={`flex items-center gap-1 text-xs ${testOk ? 'text-accent' : 'text-danger'}`}
            >
              {testOk ? <Check className="size-3.5" /> : <X className="size-3.5" />}
              {testMsg}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
