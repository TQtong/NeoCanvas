'use client';

/**
 * 模型供应商凭证设置（BYOK）。
 *
 * 内置供应商拥有固定协议与官方端点；用户还可创建多个自定义供应商实例，并为其选择已支持
 * 的兼容协议。明文密钥只经 `provider-credentials` Edge Function 写入 Vault。
 *
 * @module components/shared/settings/ProviderSettings
 */

import { useMemo, useState } from 'react';
import {
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronRight,
  KeyRound,
  Loader2,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import type { BuiltInProvider, Provider, ProviderCredential } from '@/types';
import { BUILT_IN_PROVIDERS, isCustomProvider } from '@/types';
import { useTranslation } from '@/i18n';
import {
  customProviderDefinition,
  PROVIDER_DEFINITION_BY_ID,
  PROVIDER_DEFINITIONS,
  providerDefinition,
  type ProviderDefinition,
} from '@/lib/models/providers';
import { cn } from '@/lib/utils/cn';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import {
  useProviderCredentials,
  type UseProviderCredentials,
} from '@/lib/hooks/use-provider-credentials';
import { ModelSettings } from './ModelSettings';
import { Field, Switch, TextInput } from './controls';

const CUSTOM_DRAFT_ID = 'custom:draft' as Provider;

/** 按名称生成数据库允许的自定义供应商实例标识。 */
function createCustomProviderId(name: string): Provider {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28);
  const stem = slug.length >= 3 ? slug : 'provider';
  return `custom:${stem}-${crypto.randomUUID().slice(0, 8)}`;
}

/** 模型供应商设置面板。 */
export function ProviderSettings() {
  const { t } = useTranslation();
  const api = useProviderCredentials();
  const [selectedProvider, setSelectedProvider] = useState<Provider | null>(null);
  const byProvider = useMemo(
    () => new Map(api.credentials.map((credential) => [credential.provider, credential])),
    [api.credentials],
  );
  const customCredentials = api.credentials.filter((credential) =>
    isCustomProvider(credential.provider),
  );

  if (selectedProvider) {
    const creatingCustom = selectedProvider === CUSTOM_DRAFT_ID;
    const definition = creatingCustom
      ? undefined
      : providerDefinition(selectedProvider, api.credentials);
    if (creatingCustom || definition) {
      return (
        <ProviderDetail
          key={selectedProvider}
          definition={definition}
          credential={creatingCustom ? undefined : byProvider.get(selectedProvider)}
          api={api}
          creatingCustom={creatingCustom}
          onSaved={(credential) => setSelectedProvider(credential.provider)}
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
          {PROVIDER_DEFINITIONS.map((definition) => (
            <ProviderCard
              key={definition.id}
              definition={definition}
              credential={byProvider.get(definition.id)}
              onClick={() => setSelectedProvider(definition.id)}
            />
          ))}
          {customCredentials.map((credential) => {
            const definition = customProviderDefinition(credential);
            return (
              <ProviderCard
                key={credential.id}
                definition={definition}
                credential={credential}
                onClick={() => setSelectedProvider(credential.provider)}
              />
            );
          })}
          <button
            type="button"
            onClick={() => setSelectedProvider(CUSTOM_DRAFT_ID)}
            className="group flex min-h-20 items-center gap-3 rounded-lg border border-dashed border-border bg-card p-3 text-left transition-colors hover:border-accent/60 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground group-hover:text-accent">
              <Plus className="size-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{t('providers.addCustom')}</span>
              <span className="mt-1 line-clamp-1 block text-xs text-muted-foreground">
                {t('providers.addCustomHint')}
              </span>
            </span>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
          </button>
        </div>
      )}
    </div>
  );
}

function ProviderCard({
  definition,
  credential,
  onClick,
}: {
  definition: ProviderDefinition;
  credential?: ProviderCredential;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex min-h-20 items-center gap-3 rounded-lg border border-border bg-card p-3 text-left transition-colors hover:border-accent/50 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ProviderMark definition={definition} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{definition.name}</span>
          {credential?.enabled ? <CheckCircle2 className="size-3.5 text-success" /> : null}
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
}

/** 供应商品牌标记。 */
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

/** 单个内置、自定义供应商的凭证详情。 */
function ProviderDetail({
  definition,
  credential,
  api,
  creatingCustom,
  onSaved,
  onBack,
}: {
  definition?: ProviderDefinition;
  credential?: ProviderCredential;
  api: UseProviderCredentials;
  creatingCustom: boolean;
  onSaved: (credential: ProviderCredential) => void;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const { success, error: toastError } = useToast();
  const initialAdapter = credential?.adapter ?? definition?.adapter ?? 'openai';
  const [name, setName] = useState(credential?.label ?? definition?.name ?? '');
  const [websiteUrl, setWebsiteUrl] = useState(
    credential?.websiteUrl ?? definition?.websiteUrl ?? '',
  );
  const [adapter, setAdapter] = useState<BuiltInProvider>(initialAdapter);
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [baseUrl, setBaseUrl] = useState(
    credential?.baseUrl ??
      definition?.officialBaseUrl ??
      PROVIDER_DEFINITION_BY_ID.openai.officialBaseUrl,
  );
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testOk, setTestOk] = useState<boolean | null>(null);
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const configured = Boolean(credential);
  const isCustom = creatingCustom || Boolean(definition?.isCustom);
  const authMode = adapter === 'jimeng' ? 'access-key-pair' : 'api-key';
  const shownDefinition: ProviderDefinition = definition ?? {
    id: CUSTOM_DRAFT_ID,
    adapter,
    name: name || t('providers.customName'),
    mark: name.slice(0, 1).toUpperCase() || '+',
    markClassName: 'bg-muted text-foreground',
    descriptionKey: 'providers.customDescription',
    apiKeyPlaceholder: 'sk-...',
    officialBaseUrl: baseUrl,
    websiteUrl,
    authMode,
    isCustom: true,
  };

  const validate = (): boolean => {
    if (isCustom && !name.trim()) {
      toastError(t('providers.nameRequired'));
      return false;
    }
    if (!baseUrl.trim()) {
      toastError(t('providers.baseUrlRequired'));
      return false;
    }
    if (!configured && !apiKey.trim()) {
      toastError(t('providers.keyRequired'));
      return false;
    }
    if (!configured && authMode === 'access-key-pair' && !apiSecret.trim()) {
      toastError(t('providers.secretRequired'));
      return false;
    }
    if (
      configured &&
      authMode === 'access-key-pair' &&
      Boolean(apiKey.trim()) !== Boolean(apiSecret.trim())
    ) {
      toastError(t('providers.keyPairRequired'));
      return false;
    }
    return true;
  };

  const onSave = async () => {
    if (!validate()) return;
    setSaving(true);
    try {
      const saved = await api.saveCredential({
        provider:
          credential?.provider ??
          (creatingCustom ? createCustomProviderId(name) : shownDefinition.id),
        adapter,
        apiKey: apiKey.trim() || undefined,
        apiSecret: apiSecret.trim() || undefined,
        baseUrl: baseUrl.trim(),
        label: isCustom ? name.trim() : null,
        websiteUrl: isCustom ? websiteUrl.trim() || null : shownDefinition.websiteUrl,
      });
      setApiKey('');
      setApiSecret('');
      setTestOk(null);
      setTestMsg(null);
      success(t('providers.saved'));
      onSaved(saved);
    } catch (err) {
      toastError(err instanceof Error ? err.message : t('providers.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const onTest = async () => {
    if (!validate()) return;
    setTesting(true);
    setTestOk(null);
    setTestMsg(null);
    try {
      const result = await api.testCredential({
        provider: credential?.provider ?? (creatingCustom ? CUSTOM_DRAFT_ID : shownDefinition.id),
        adapter,
        apiKey: apiKey.trim() || undefined,
        apiSecret: apiSecret.trim() || undefined,
        baseUrl: baseUrl.trim(),
      });
      setTestOk(result.ok);
      setTestMsg(result.message ?? (result.ok ? t('providers.testOk') : t('providers.testFailed')));
    } catch (err) {
      setTestOk(false);
      setTestMsg(err instanceof Error ? err.message : t('providers.testFailed'));
    } finally {
      setTesting(false);
    }
  };

  const onToggle = async (next: boolean) => {
    if (!credential) return;
    try {
      await api.toggleCredential(credential.provider, next);
    } catch (err) {
      toastError(err instanceof Error ? err.message : t('providers.saveFailed'));
    }
  };

  const onDelete = async () => {
    if (!credential || !window.confirm(t('providers.deleteConfirm'))) return;
    try {
      await api.deleteCredential(credential.id);
      success(t('providers.deleted'));
      onBack();
    } catch (err) {
      toastError(err instanceof Error ? err.message : t('providers.saveFailed'));
    }
  };

  const onAdapterChange = (next: BuiltInProvider) => {
    setAdapter(next);
    setApiKey('');
    setApiSecret('');
    setBaseUrl(PROVIDER_DEFINITION_BY_ID[next].officialBaseUrl);
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
        <ProviderMark definition={shownDefinition} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-base font-semibold">
            {creatingCustom ? t('providers.addCustom') : shownDefinition.name}
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t(shownDefinition.descriptionKey)}
          </p>
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
          <span className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
            {credential ? `••••${credential.keyLast4}` : t('providers.notConfigured')}
          </span>
        </div>

        <div className="flex flex-col gap-4">
          {isCustom ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label={t('providers.customName')}>
                <TextInput
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="MiniMax 企业网关"
                />
              </Field>
              <Field label={t('providers.websiteUrl')}>
                <TextInput
                  type="url"
                  value={websiteUrl}
                  onChange={(event) => setWebsiteUrl(event.target.value)}
                  placeholder="https://example.com"
                />
              </Field>
              <Field label={t('providers.adapter')} hint={t('providers.adapterHint')}>
                <select
                  value={adapter}
                  disabled={configured}
                  onChange={(event) => onAdapterChange(event.target.value as BuiltInProvider)}
                  className="h-10 w-full rounded-xl border border-border bg-background px-3 text-sm outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-ring disabled:opacity-60"
                >
                  {BUILT_IN_PROVIDERS.map((item) => (
                    <option key={item} value={item}>
                      {PROVIDER_DEFINITION_BY_ID[item].name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          ) : null}

          <Field
            label={authMode === 'access-key-pair' ? 'Access Key ID' : t('providers.apiKey')}
            hint={configured ? t('providers.keyHintConfigured') : t('providers.keyHintNew')}
          >
            <TextInput
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={
                configured
                  ? t('providers.keyPlaceholderConfigured')
                  : shownDefinition.apiKeyPlaceholder
              }
            />
          </Field>
          {authMode === 'access-key-pair' ? (
            <Field label="Secret Access Key" hint={t('providers.secretHint')}>
              <TextInput
                type="password"
                autoComplete="off"
                value={apiSecret}
                onChange={(event) => setApiSecret(event.target.value)}
                placeholder={
                  configured ? t('providers.keyPlaceholderConfigured') : '输入 Secret Access Key'
                }
              />
            </Field>
          ) : null}
          <Field label={t('providers.baseUrl')} hint={t('providers.baseUrlHint')}>
            <TextInput
              type="url"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder={shownDefinition.officialBaseUrl}
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

      {credential && isCustom ? (
        <div className="rounded-lg border border-border p-4 sm:p-5">
          <h4 className="mb-1 text-sm font-semibold">{t('providers.customModels')}</h4>
          <p className="mb-4 text-xs text-muted-foreground">{t('providers.customModelsHint')}</p>
          <ModelSettings providerFilter={credential.provider} providerLabel={name} />
        </div>
      ) : null}
    </div>
  );
}
