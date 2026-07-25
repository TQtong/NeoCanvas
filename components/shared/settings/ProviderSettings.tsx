'use client';

/**
 * 模型提供商凭证设置（BYOK）。
 *
 * 首层只呈现提供商目录与配置状态；用户点击后进入单个提供商详情填写密钥和可选端点。
 * 明文 Key 经 `provider-credentials` 边缘函数写入 Vault，永不回流浏览器。
 *
 * @module components/shared/settings/ProviderSettings
 */

import { useEffect, useState } from 'react';
import {
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronRight,
  KeyRound,
  Loader2,
  Trash2,
  X,
} from 'lucide-react';
import type { Provider, ProviderCredential } from '@/types';
import { useTranslation } from '@/i18n';
import { PROVIDER_DEFINITIONS, type ProviderDefinition } from '@/lib/models/providers';
import { cn } from '@/lib/utils/cn';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import {
  useProviderCredentials,
  type UseProviderCredentials,
} from '@/lib/hooks/use-provider-credentials';
import { Field, Switch, TextInput } from './controls';

/** 模型提供商设置面板。 */
export function ProviderSettings() {
  const { t } = useTranslation();
  const api = useProviderCredentials();
  const [selectedProvider, setSelectedProvider] = useState<Provider | null>(null);
  const byProvider = new Map(
    api.credentials.map((credential) => [credential.provider, credential]),
  );

  if (selectedProvider) {
    const definition = PROVIDER_DEFINITIONS.find((item) => item.id === selectedProvider);
    if (definition) {
      return (
        <ProviderDetail
          key={selectedProvider}
          definition={definition}
          credential={byProvider.get(selectedProvider)}
          api={api}
          onBack={() => setSelectedProvider(null)}
        />
      );
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="text-sm font-semibold">{t('providers.heading')}</h3>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t('providers.intro')}</p>
      </div>

      {api.loading ? (
        <div className="flex justify-center py-12 text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {PROVIDER_DEFINITIONS.map((definition) => {
            const credential = byProvider.get(definition.id);
            return (
              <button
                key={definition.id}
                type="button"
                onClick={() => setSelectedProvider(definition.id)}
                className="group flex min-h-20 items-center gap-3 rounded-lg border border-border bg-card p-3 text-left transition-colors hover:border-accent/50 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ProviderMark definition={definition} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{definition.name}</span>
                    {credential?.enabled ? (
                      <CheckCircle2 className="size-3.5 shrink-0 text-success" />
                    ) : null}
                  </span>
                  <span className="mt-1 line-clamp-1 block text-xs text-muted-foreground">
                    {credential
                      ? credential.enabled
                        ? `${t('providers.configured')} · ••••${credential.keyLast4}`
                        : t('providers.disabled')
                      : t(definition.descriptionKey)}
                  </span>
                </span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** 提供商品牌标记。 */
function ProviderMark({ definition }: { definition: ProviderDefinition }) {
  return (
    <span
      className={cn(
        'flex size-10 shrink-0 items-center justify-center rounded-lg text-sm font-semibold',
        definition.markClassName,
      )}
      aria-hidden="true"
    >
      {definition.mark}
    </span>
  );
}

/** 单个提供商的凭据详情。 */
function ProviderDetail({
  definition,
  credential,
  api,
  onBack,
}: {
  definition: ProviderDefinition;
  credential: ProviderCredential | undefined;
  api: UseProviderCredentials;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const { success, error: toastError } = useToast();
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(credential?.baseUrl ?? definition.officialBaseUrl);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testOk, setTestOk] = useState<boolean | null>(null);
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const configured = Boolean(credential);

  useEffect(() => {
    setBaseUrl(credential?.baseUrl ?? definition.officialBaseUrl);
  }, [credential?.baseUrl, definition.officialBaseUrl]);

  /** 保存新凭据或更新当前提供商配置。 */
  const onSave = async () => {
    if (!configured && !apiKey.trim()) {
      toastError(t('providers.keyRequired'));
      return;
    }
    setSaving(true);
    try {
      await api.saveCredential({
        provider: definition.id,
        apiKey: apiKey.trim() || undefined,
        baseUrl: baseUrl.trim() || definition.officialBaseUrl,
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

  /** 测试输入中的凭据；Key 留空时由边缘函数使用已存密钥。 */
  const onTest = async () => {
    setTesting(true);
    setTestOk(null);
    setTestMsg(null);
    try {
      const result = await api.testCredential({
        provider: definition.id,
        apiKey: apiKey.trim() || undefined,
        baseUrl: baseUrl.trim() || definition.officialBaseUrl,
      });
      setTestOk(result.ok);
      setTestMsg(result.ok ? t('providers.testOk') : (result.message ?? t('providers.testFailed')));
    } catch (err) {
      setTestOk(false);
      setTestMsg(err instanceof Error ? err.message : t('providers.testFailed'));
    } finally {
      setTesting(false);
    }
  };

  /** 启用或停用当前凭据。 */
  const onToggle = async (next: boolean) => {
    try {
      await api.toggleCredential(definition.id, next);
    } catch (err) {
      toastError(err instanceof Error ? err.message : t('providers.saveFailed'));
    }
  };

  /** 删除当前凭据及其 Vault 密钥。 */
  const onDelete = async () => {
    if (!credential || !window.confirm(t('providers.deleteConfirm'))) return;
    try {
      await api.deleteCredential(credential.id);
      setApiKey('');
      setBaseUrl(definition.officialBaseUrl);
      success(t('providers.deleted'));
    } catch (err) {
      toastError(err instanceof Error ? err.message : t('providers.saveFailed'));
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          aria-label={t('providers.back')}
          className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ArrowLeft className="size-4" />
        </button>
        <ProviderMark definition={definition} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-base font-semibold">{definition.name}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{t(definition.descriptionKey)}</p>
        </div>
        {credential ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {credential.enabled ? t('providers.enabled') : t('providers.disabled')}
            </span>
            <Switch checked={credential.enabled} onChange={(next) => void onToggle(next)} />
          </div>
        ) : null}
      </div>

      <div className="rounded-lg border border-border p-4 sm:p-5">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <KeyRound className="size-4 text-muted-foreground" />
            <span className="text-sm font-medium">{t('providers.credential')}</span>
          </div>
          {credential ? (
            <span className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
              ••••{credential.keyLast4}
            </span>
          ) : (
            <span className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
              {t('providers.notConfigured')}
            </span>
          )}
        </div>

        <div className="flex flex-col gap-4">
          <Field
            label={t('providers.apiKey')}
            hint={configured ? t('providers.keyHintConfigured') : t('providers.keyHintNew')}
          >
            <TextInput
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={
                configured ? t('providers.keyPlaceholderConfigured') : definition.apiKeyPlaceholder
              }
            />
          </Field>
          <Field label={t('providers.baseUrl')} hint={t('providers.baseUrlHint')}>
            <TextInput
              type="url"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder={definition.officialBaseUrl}
            />
          </Field>

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button variant="outline" size="sm" onClick={() => void onTest()} loading={testing}>
              {t('providers.test')}
            </Button>
            <Button size="sm" onClick={() => void onSave()} loading={saving}>
              {t('common.save')}
            </Button>
            {credential ? (
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto text-danger hover:bg-danger/10 hover:text-danger"
                onClick={() => void onDelete()}
              >
                <Trash2 className="size-4" />
                {t('common.delete')}
              </Button>
            ) : null}
          </div>

          {testOk != null ? (
            <div
              className={cn(
                'flex items-center gap-1.5 rounded-md px-3 py-2 text-xs',
                testOk ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger',
              )}
            >
              {testOk ? <Check className="size-3.5" /> : <X className="size-3.5" />}
              {testMsg}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
