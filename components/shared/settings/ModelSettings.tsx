'use client';

/**
 * 模型管理。
 *
 * 列出「内置（只读）+ 本人自有（可启停/编辑/删除）」模型；可新增绑定到已配置 provider 的
 * 自有模型，按模态填写完整能力画像。模型不涉及密钥，故增删改经 RLS 直接写 `model_catalog`。
 *
 * @module components/shared/settings/ModelSettings
 */

import { useState } from 'react';
import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import type {
  AspectRatio,
  ImageInputFidelity,
  ImageOperation,
  ImageQuality,
  ImageUpscaleFactor,
  ModelCapabilities,
  ModelCatalogEntry,
  ModelDefaultParams,
  Provider,
} from '@/types';
import {
  ASPECT_RATIOS,
  IMAGE_INPUT_FIDELITIES,
  IMAGE_OPERATIONS,
  IMAGE_QUALITIES,
  IMAGE_UPSCALE_FACTORS,
} from '@/types';
import { useTranslation } from '@/i18n';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { useManagedModels, type ManagedModelInput } from '@/lib/hooks/use-managed-models';
import { useProviderCredentials } from '@/lib/hooks/use-provider-credentials';
import { Chip, CheckRow, Field, NumberInput, Switch, TextInput } from './controls';

/** 可选视频分辨率档。 */
const VIDEO_RESOLUTIONS = ['480p', '720p', '1080p'] as const;

/** 表单态（新增 / 编辑共用）。 */
interface FormState {
  editingKey: string | null;
  key: string;
  displayName: string;
  provider: Provider | '';
  modality: 'image' | 'video';
  providerModel: string;
  aspectRatios: AspectRatio[];
  maxOutputs: number;
  imageOperations: ImageOperation[];
  maxInputImages: number;
  inputFidelityOptions: ImageInputFidelity[];
  upscaleFactors: ImageUpscaleFactor[];
  supportsTransparentOutput: boolean;
  maxInputPixels: number;
  qualities: ImageQuality[];
  videoResolutions: string[];
  durMin: number;
  durMax: number;
  supportsReferenceImages: boolean;
  supportsNegativePrompt: boolean;
  supportsSeed: boolean;
  supportsImageToVideo: boolean;
  supportsKeyframeSequence: boolean;
  supportsMotionStrength: boolean;
  isAsync: boolean;
}

/** 新增表单的初值。 */
function emptyForm(provider: Provider | ''): FormState {
  return {
    editingKey: null,
    key: '',
    displayName: '',
    provider,
    modality: 'image',
    providerModel: '',
    aspectRatios: ['1:1'],
    maxOutputs: 1,
    imageOperations: ['generate'],
    maxInputImages: 1,
    inputFidelityOptions: [],
    upscaleFactors: [],
    supportsTransparentOutput: false,
    maxInputPixels: 16_777_216,
    qualities: [],
    videoResolutions: ['720p'],
    durMin: 3,
    durMax: 6,
    supportsReferenceImages: false,
    supportsNegativePrompt: false,
    supportsSeed: false,
    supportsImageToVideo: false,
    supportsKeyframeSequence: false,
    supportsMotionStrength: false,
    isAsync: false,
  };
}

/** 既有自有模型 → 表单态（供编辑回填）。 */
function entryToForm(e: ModelCatalogEntry): FormState {
  const cap = e.capabilities;
  return {
    editingKey: e.key,
    key: e.key,
    displayName: e.displayName,
    provider: e.provider,
    modality: e.modality === 'video' ? 'video' : 'image',
    providerModel: e.defaultParams.providerModel ?? '',
    aspectRatios: cap.aspectRatios ?? [],
    maxOutputs: cap.maxOutputs ?? 1,
    imageOperations:
      cap.imageOperations ??
      (cap.supportsReferenceImages ? ['generate', 'semantic_edit'] : ['generate']),
    maxInputImages: cap.maxInputImages ?? 1,
    inputFidelityOptions: cap.inputFidelityOptions ?? [],
    upscaleFactors: cap.upscaleFactors ?? [],
    supportsTransparentOutput: Boolean(cap.supportsTransparentOutput),
    maxInputPixels: cap.maxInputPixels ?? 16_777_216,
    qualities: cap.qualities ?? [],
    videoResolutions: cap.videoResolutions ?? ['720p'],
    durMin: cap.videoDurationRange?.min ?? 3,
    durMax: cap.videoDurationRange?.max ?? 6,
    supportsReferenceImages: cap.supportsReferenceImages,
    supportsNegativePrompt: cap.supportsNegativePrompt,
    supportsSeed: cap.supportsSeed,
    supportsImageToVideo: cap.supportsImageToVideo,
    supportsKeyframeSequence: Boolean(cap.supportsKeyframeSequence),
    supportsMotionStrength: Boolean(cap.supportsMotionStrength),
    isAsync: cap.isAsync,
  };
}

/** 表单态 → 提交输入（构造完整能力画像与默认参数）。 */
function formToInput(f: FormState): ManagedModelInput {
  const capabilities: ModelCapabilities = {
    imageOperations: f.modality === 'image' ? f.imageOperations : [],
    aspectRatios: f.aspectRatios,
    sizes: [],
    maxOutputs: Math.max(1, f.maxOutputs),
    supportsNegativePrompt: f.supportsNegativePrompt,
    supportsReferenceImages: f.supportsReferenceImages,
    supportsImageToVideo: f.modality === 'video' ? f.supportsImageToVideo : false,
    supportsSeed: f.supportsSeed,
    qualities: f.modality === 'image' ? f.qualities : [],
    isAsync: f.isAsync,
    supportsWebhook: false,
  };
  if (f.modality === 'image') {
    capabilities.maxInputImages = Math.max(1, f.maxInputImages);
    capabilities.inputFidelityOptions = f.inputFidelityOptions;
    capabilities.upscaleFactors = f.upscaleFactors;
    capabilities.supportsTransparentOutput = f.supportsTransparentOutput;
    capabilities.maxInputPixels = Math.max(1, f.maxInputPixels);
  }
  if (f.modality === 'video') {
    capabilities.videoResolutions = f.videoResolutions;
    capabilities.videoDurationRange = { min: f.durMin, max: f.durMax };
    capabilities.supportsMotionStrength = f.supportsMotionStrength;
    capabilities.supportsKeyframeSequence = f.supportsKeyframeSequence;
  }
  const defaultParams: ModelDefaultParams =
    f.modality === 'image'
      ? { providerModel: f.providerModel, aspectRatio: f.aspectRatios[0] ?? '1:1', count: 1 }
      : {
          providerModel: f.providerModel,
          resolution: f.videoResolutions[0] ?? '720p',
          durationSec: f.durMin,
          fps: 24,
          aspectRatio: f.aspectRatios[0] ?? '16:9',
        };
  return {
    key: f.key.trim(),
    displayName: f.displayName.trim(),
    provider: f.provider as Provider,
    modality: f.modality,
    capabilities,
    defaultParams,
    isActive: true,
  };
}

/** 切换数组元素（多选集合）。 */
function toggleIn<T>(arr: T[], value: T): T[] {
  return arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value];
}

/**
 * 模型管理面板。
 */
export interface ModelSettingsProps {
  /** 限定只管理某个供应商的模型；用于自定义供应商详情。 */
  providerFilter?: Provider;
  /** 限定供应商的展示名。 */
  providerLabel?: string;
}

export function ModelSettings({ providerFilter, providerLabel }: ModelSettingsProps = {}) {
  const { t } = useTranslation();
  const { success, error: toastError } = useToast();
  const models = useManagedModels();
  const providerApi = useProviderCredentials();

  const configuredProviders = providerApi.credentials
    .filter((credential) => !providerFilter || credential.provider === providerFilter)
    .map((credential) => credential.provider);
  const visibleModels = providerFilter
    ? models.models.filter((model) => model.provider === providerFilter && model.userId != null)
    : models.models;
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));

  const openAdd = () => {
    if (configuredProviders.length === 0) {
      toastError(t('models.needProvider'));
      return;
    }
    setForm(emptyForm(configuredProviders[0] ?? ''));
  };

  const onSubmit = async () => {
    if (!form) return;
    if (
      !form.key.trim() ||
      !form.displayName.trim() ||
      !form.provider ||
      !form.providerModel.trim()
    ) {
      toastError(t('models.fieldsRequired'));
      return;
    }
    if (form.aspectRatios.length === 0) {
      toastError(t('models.aspectRequired'));
      return;
    }
    if (form.modality === 'image' && form.imageOperations.length === 0) {
      toastError(t('models.operationRequired'));
      return;
    }
    setSaving(true);
    try {
      const input = formToInput(form);
      if (form.editingKey) {
        await models.updateModel(form.editingKey, input);
      } else {
        await models.addModel(input);
      }
      success(t('models.saved'));
      setForm(null);
    } catch (err) {
      toastError(err instanceof Error ? err.message : t('models.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const onDelete = async (key: string) => {
    try {
      await models.deleteModel(key);
      success(t('models.deleted'));
    } catch (err) {
      toastError(err instanceof Error ? err.message : t('models.saveFailed'));
    }
  };

  const onToggle = async (key: string, next: boolean) => {
    try {
      await models.toggleModel(key, next);
    } catch (err) {
      toastError(err instanceof Error ? err.message : t('models.saveFailed'));
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">{t('models.intro')}</p>
        <Button size="sm" variant="outline" onClick={openAdd}>
          <Plus className="size-4" />
          {t('models.add')}
        </Button>
      </div>

      {form ? (
        <ModelForm
          form={form}
          set={set}
          saving={saving}
          configuredProviders={configuredProviders}
          providerLabel={providerLabel}
          onSubmit={() => void onSubmit()}
          onCancel={() => setForm(null)}
        />
      ) : null}

      {models.loading ? (
        <div className="flex justify-center py-8 text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {visibleModels.map((m) => {
            const own = m.userId != null;
            return (
              <div
                key={m.key}
                className="flex items-center justify-between rounded-xl border border-border px-4 py-3"
              >
                <div className="flex min-w-0 flex-col">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{m.displayName}</span>
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {own ? t('models.badgeOwn') : t('models.badgeBuiltin')}
                    </span>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {m.provider} · {m.modality} · {m.key}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {own ? (
                    <>
                      <Switch checked={m.isActive} onChange={(n) => void onToggle(m.key, n)} />
                      <button
                        type="button"
                        aria-label={t('common.edit')}
                        onClick={() => setForm(entryToForm(m))}
                        className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      >
                        <Pencil className="size-4" />
                      </button>
                      <button
                        type="button"
                        aria-label={t('common.delete')}
                        onClick={() => void onDelete(m.key)}
                        className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-danger/10 hover:text-danger"
                      >
                        <Trash2 className="size-4" />
                      </button>
                    </>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      {m.isActive ? t('providers.enabled') : t('providers.disabled')}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** 新增 / 编辑模型的表单。 */
function ModelForm({
  form,
  set,
  saving,
  configuredProviders,
  providerLabel,
  onSubmit,
  onCancel,
}: {
  form: FormState;
  set: <K extends keyof FormState>(key: K, value: FormState[K]) => void;
  saving: boolean;
  configuredProviders: Provider[];
  providerLabel?: string;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const inputClass =
    'h-10 w-full rounded-xl border border-border bg-background px-3 text-sm outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-ring';

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-accent/40 bg-accent-muted/30 p-4">
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('models.key')} hint={t('models.keyHint')}>
          <TextInput
            value={form.key}
            disabled={Boolean(form.editingKey)}
            onChange={(e) => set('key', e.target.value)}
            placeholder="my-flux-pro"
          />
        </Field>
        <Field label={t('models.displayName')}>
          <TextInput
            value={form.displayName}
            onChange={(e) => set('displayName', e.target.value)}
            placeholder="My FLUX Pro"
          />
        </Field>
        <Field label={t('models.provider')}>
          {configuredProviders.length === 1 ? (
            <TextInput value={providerLabel ?? configuredProviders[0]} disabled />
          ) : (
            <select
              value={form.provider}
              onChange={(e) => set('provider', e.target.value as Provider)}
              className={inputClass}
            >
              {configuredProviders.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={t('models.modality')}>
          <select
            value={form.modality}
            onChange={(e) => set('modality', e.target.value as 'image' | 'video')}
            className={inputClass}
          >
            <option value="image">image</option>
            <option value="video">video</option>
          </select>
        </Field>
      </div>

      <Field label={t('models.providerModel')} hint={t('models.providerModelHint')}>
        <TextInput
          value={form.providerModel}
          onChange={(e) => set('providerModel', e.target.value)}
          placeholder="Kwai-Kolors/Kolors"
        />
      </Field>

      <div className="flex flex-col gap-1.5">
        <span className="text-sm text-muted-foreground">{t('models.aspectRatios')}</span>
        <div className="flex flex-wrap gap-1.5">
          {ASPECT_RATIOS.map((r) => (
            <Chip
              key={r}
              active={form.aspectRatios.includes(r)}
              onClick={() => set('aspectRatios', toggleIn(form.aspectRatios, r))}
            >
              {r}
            </Chip>
          ))}
        </div>
      </div>

      {form.modality === 'image' ? (
        <>
          <div className="flex flex-col gap-1.5">
            <span className="text-sm text-muted-foreground">{t('models.imageOperations')}</span>
            <div className="flex flex-wrap gap-1.5">
              {IMAGE_OPERATIONS.map((operation) => (
                <Chip
                  key={operation}
                  active={form.imageOperations.includes(operation)}
                  onClick={() => set('imageOperations', toggleIn(form.imageOperations, operation))}
                >
                  {t(`models.operation.${operation}`)}
                </Chip>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('models.maxOutputs')}>
              <NumberInput
                min={1}
                max={8}
                value={form.maxOutputs}
                onChange={(e) => set('maxOutputs', Number(e.target.value) || 1)}
              />
            </Field>
            <Field label={t('models.maxInputImages')}>
              <NumberInput
                min={1}
                max={16}
                value={form.maxInputImages}
                onChange={(e) => set('maxInputImages', Number(e.target.value) || 1)}
              />
            </Field>
            <Field label={t('models.maxInputPixels')}>
              <NumberInput
                min={1}
                value={form.maxInputPixels}
                onChange={(e) => set('maxInputPixels', Number(e.target.value) || 1)}
              />
            </Field>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-sm text-muted-foreground">{t('models.qualities')}</span>
            <div className="flex flex-wrap gap-1.5">
              {IMAGE_QUALITIES.map((q) => (
                <Chip
                  key={q}
                  active={form.qualities.includes(q)}
                  onClick={() => set('qualities', toggleIn(form.qualities, q))}
                >
                  {q}
                </Chip>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-sm text-muted-foreground">{t('models.inputFidelity')}</span>
            <div className="flex flex-wrap gap-1.5">
              {IMAGE_INPUT_FIDELITIES.map((fidelity) => (
                <Chip
                  key={fidelity}
                  active={form.inputFidelityOptions.includes(fidelity)}
                  onClick={() =>
                    set('inputFidelityOptions', toggleIn(form.inputFidelityOptions, fidelity))
                  }
                >
                  {fidelity}
                </Chip>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-sm text-muted-foreground">{t('models.upscaleFactors')}</span>
            <div className="flex flex-wrap gap-1.5">
              {IMAGE_UPSCALE_FACTORS.map((factor) => (
                <Chip
                  key={factor}
                  active={form.upscaleFactors.includes(factor)}
                  onClick={() => set('upscaleFactors', toggleIn(form.upscaleFactors, factor))}
                >
                  {factor}×
                </Chip>
              ))}
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="flex flex-col gap-1.5">
            <span className="text-sm text-muted-foreground">{t('models.videoResolutions')}</span>
            <div className="flex flex-wrap gap-1.5">
              {VIDEO_RESOLUTIONS.map((r) => (
                <Chip
                  key={r}
                  active={form.videoResolutions.includes(r)}
                  onClick={() => set('videoResolutions', toggleIn(form.videoResolutions, r))}
                >
                  {r}
                </Chip>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('models.durMin')}>
              <NumberInput
                min={1}
                value={form.durMin}
                onChange={(e) => set('durMin', Number(e.target.value) || 1)}
              />
            </Field>
            <Field label={t('models.durMax')}>
              <NumberInput
                min={1}
                value={form.durMax}
                onChange={(e) => set('durMax', Number(e.target.value) || 1)}
              />
            </Field>
          </div>
        </>
      )}

      <div className="grid grid-cols-2 gap-2 rounded-lg border border-border/60 p-3">
        <CheckRow
          checked={form.supportsReferenceImages}
          onChange={(v) => set('supportsReferenceImages', v)}
          label={t('models.capRefImages')}
        />
        <CheckRow
          checked={form.supportsNegativePrompt}
          onChange={(v) => set('supportsNegativePrompt', v)}
          label={t('models.capNegative')}
        />
        <CheckRow
          checked={form.supportsSeed}
          onChange={(v) => set('supportsSeed', v)}
          label={t('models.capSeed')}
        />
        <CheckRow
          checked={form.isAsync}
          onChange={(v) => set('isAsync', v)}
          label={t('models.capAsync')}
        />
        {form.modality === 'image' ? (
          <CheckRow
            checked={form.supportsTransparentOutput}
            onChange={(v) => set('supportsTransparentOutput', v)}
            label={t('models.capTransparent')}
          />
        ) : null}
        {form.modality === 'video' ? (
          <>
            <CheckRow
              checked={form.supportsImageToVideo}
              onChange={(v) => set('supportsImageToVideo', v)}
              label={t('models.capImageToVideo')}
            />
            <CheckRow
              checked={form.supportsKeyframeSequence}
              onChange={(v) => set('supportsKeyframeSequence', v)}
              label={t('models.capKeyframes')}
            />
            <CheckRow
              checked={form.supportsMotionStrength}
              onChange={(v) => set('supportsMotionStrength', v)}
              label={t('models.capMotion')}
            />
          </>
        ) : null}
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button size="sm" onClick={onSubmit} loading={saving}>
          {t('common.save')}
        </Button>
      </div>
    </div>
  );
}
