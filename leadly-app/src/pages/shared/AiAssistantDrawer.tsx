import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { createAiAssistant, getAiAssistant, updateAiAssistant } from '../../lib/api/aiAssistants'
import { listAiModels } from '../../lib/api/aiModels'
import { listAiSkills, listEnabledSkillKeys, setSkillEnabled } from '../../lib/api/aiSkills'
import type { AiAssistant, AiModel, AiProvider, AiSkill } from '../../types/domain'
import { useAuth } from '../../contexts/AuthContext'
import { useLanguage } from '../../contexts/LanguageContext'
import type { TranslationKey } from '../../i18n/translations'
import { FieldError, PageSpinner } from '@/components/atoms'
import { ComboboxFilter } from '@/components/molecules'
import { Drawer } from '@/components/organisms'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useAiAssistantForm } from './useAiAssistantForm'

const PROVIDER_KEY: Record<AiProvider, TranslationKey> = {
  openai: 'settings.assistant.provider.openai',
  gemini: 'settings.assistant.provider.gemini',
}

const FORM_ID = 'ai-assistant-form'
const FIELD_CLASS = '!h-7 !rounded-lg !text-xs'
const TEXTAREA_CLASS = '!rounded-lg !py-1.5 !text-xs'
const COMBOBOX_TRIGGER_CLASS = 'flex-1 !rounded-lg'

/** Small section label used to visually group the form instead of one long
 * flat list of fields -- makes it scannable at a glance (what provider/model,
 * what it says, how it behaves) instead of reading every label top to bottom. */
function FormSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-brand-400">{title}</h3>
      {children}
    </div>
  )
}

/** Shared between the backoffice (from a Cliente's Líneas section) and the
 * tenant panel ("IA & Agentes") -- same config, same rules, only the caller
 * differs. `assistantId: null` opens the drawer in create mode (a brand new
 * agent for `tenantId`) instead of editing an existing one -- agents are no
 * longer owned 1:1 by a line (2026-08-06), so this drawer only ever talks
 * about "an agent", never "this line's agent". */
export function AiAssistantDrawer({
  open,
  onClose,
  tenantId,
  assistantId,
  manageSkills = false,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  tenantId: string
  assistantId: string | null
  /** Only the backoffice passes this -- enabling/disabling a skill is a
   * superadmin action (RLS-enforced too), the tenant's own "IA & Agentes"
   * screen never shows it. Also unavailable while creating: skills apply to
   * an existing agent id, there's nothing to toggle before the first save. */
  manageSkills?: boolean
  onSaved?: (assistant: AiAssistant) => void
}) {
  const { profile } = useAuth()
  const { t } = useLanguage()
  const isCreating = assistantId === null
  const [assistant, setAssistant] = useState<AiAssistant | null | undefined>(undefined)
  const [models, setModels] = useState<AiModel[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setModels(null)
    setLoadError(null)
    setFormError(null)
    if (isCreating) {
      setAssistant(null)
      listAiModels()
        .then(setModels)
        .catch((err) => setLoadError(err.message ?? t('settings.assistant.errors.loadModels')))
      return
    }
    setAssistant(undefined)
    Promise.all([getAiAssistant(assistantId), listAiModels()])
      .then(([a, m]) => {
        setAssistant(a)
        setModels(m)
      })
      .catch((err) => setLoadError(err.message ?? t('settings.assistant.errors.loadAssistant')))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, assistantId, isCreating])

  const loading = !models || (!isCreating && assistant === undefined)
  const ready = !loadError && !loading

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={isCreating ? t('settings.assistant.createTitle') : t('settings.assistant.editTitle')}
      description={isCreating ? t('settings.assistant.createDescription') : (assistant?.name ?? '')}
      footer={
        ready ? (
          <div className="flex gap-2">
            <Button type="submit" form={FORM_ID} disabled={submitting}>
              {submitting ? t('common.actions.saving') : isCreating ? t('settings.assistant.create') : t('common.actions.saveChanges')}
            </Button>
            <Button type="button" variant="ghost" onClick={onClose} disabled={submitting}>
              {t('common.actions.cancel')}
            </Button>
          </div>
        ) : undefined
      }
    >
      {loadError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{loadError}</p>}
      {!loadError && loading && <PageSpinner />}
      {ready && (
        <AiAssistantDrawerForm
          tenantId={tenantId}
          assistant={assistant ?? null}
          models={models}
          updatedBy={profile?.id ?? ''}
          setSubmitting={setSubmitting}
          formError={formError}
          setFormError={setFormError}
          onClose={onClose}
          onSaved={onSaved}
        />
      )}

      {ready && assistant && <SkillsSection assistantId={assistant.id} updatedBy={profile?.id ?? ''} readOnly={!manageSkills} />}
    </Drawer>
  )
}

/** Toggles apply immediately (same pattern as the mode switch elsewhere in
 * the app) -- deliberately independent of the form's own "Guardar cambios",
 * since enabling a skill is a separate action from editing the prompt/model.
 * In read-only mode (the tenant's own "Asistente de IA" screen) this just
 * shows what's active, with no switches -- habilidades son lo que el
 * superadmin le vendió/habilitó al cliente, no algo que el tenant se
 * autoconceda (ver CLAUDE.md 3.5). */
function SkillsSection({ assistantId, updatedBy, readOnly }: { assistantId: string; updatedBy: string; readOnly: boolean }) {
  const { t } = useLanguage()
  const [skills, setSkills] = useState<AiSkill[] | null>(null)
  const [enabledKeys, setEnabledKeys] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [togglingKey, setTogglingKey] = useState<string | null>(null)

  useEffect(() => {
    setSkills(null)
    setError(null)
    Promise.all([listAiSkills(), listEnabledSkillKeys(assistantId)])
      .then(([s, keys]) => {
        setSkills(s)
        setEnabledKeys(keys)
      })
      .catch((err) => setError(err.message ?? t('settings.assistant.skills.errors.load')))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assistantId])

  async function handleToggle(skillKey: string, enable: boolean) {
    setTogglingKey(skillKey)
    setError(null)
    try {
      await setSkillEnabled(assistantId, skillKey, enable, updatedBy)
      setEnabledKeys((prev) => {
        const next = new Set(prev)
        if (enable) next.add(skillKey)
        else next.delete(skillKey)
        return next
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : t('settings.assistant.skills.errors.toggle'))
    } finally {
      setTogglingKey(null)
    }
  }

  return (
    <div className="mt-6 space-y-3 border-t border-brand-100 pt-6">
      <FormSection title={t('settings.assistant.skills.title')}>
        <p className="-mt-1 text-xs text-brand-400">
          {readOnly ? t('settings.assistant.skills.descriptionReadOnly') : t('settings.assistant.skills.descriptionEditable')}
        </p>
        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        {!skills && !error && <PageSpinner />}
        {skills && skills.length === 0 && <p className="text-sm text-brand-400">{t('settings.assistant.skills.emptyCatalog')}</p>}
        {readOnly && skills && skills.length > 0 && enabledKeys.size === 0 && (
          <p className="text-sm text-brand-400">{t('settings.assistant.skills.emptyReadOnly')}</p>
        )}
        {skills && skills.length > 0 && (readOnly ? enabledKeys.size > 0 : true) && (
          <div className="space-y-2">
            {skills
              .filter((skill) => !readOnly || enabledKeys.has(skill.key))
              .map((skill) => {
                const enabled = enabledKeys.has(skill.key)
                return (
                  <div key={skill.id} className="flex items-start justify-between gap-3 rounded-xl border border-brand-100 px-4 py-3">
                    <div>
                      <p className="text-sm font-medium text-brand-800">{skill.name}</p>
                      <p className="mt-0.5 text-xs text-brand-400">{skill.description}</p>
                    </div>
                    {readOnly ? (
                      <Badge variant="outline" className="border-transparent bg-emerald-100 text-emerald-700">
                        {t('settings.assistant.skills.activeBadge')}
                      </Badge>
                    ) : (
                      <Switch checked={enabled} disabled={togglingKey === skill.key} onCheckedChange={(v) => handleToggle(skill.key, v)} />
                    )}
                  </div>
                )
              })}
          </div>
        )}
      </FormSection>
    </div>
  )
}

function AiAssistantDrawerForm({
  tenantId,
  assistant,
  models,
  updatedBy,
  setSubmitting,
  formError,
  setFormError,
  onClose,
  onSaved,
}: {
  tenantId: string
  assistant: AiAssistant | null
  models: AiModel[]
  updatedBy: string
  setSubmitting: (v: boolean) => void
  formError: string | null
  setFormError: (v: string | null) => void
  onClose: () => void
  onSaved?: (assistant: AiAssistant) => void
}) {
  const { t } = useLanguage()
  const form = useAiAssistantForm(assistant, models)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    form.setTouched(true)
    setFormError(null)
    if (!form.isValid()) return

    setSubmitting(true)
    try {
      const saved = assistant ? await updateAiAssistant(assistant.id, form.toInput(), updatedBy) : await createAiAssistant(tenantId, form.toInput())
      onSaved?.(saved)
      onClose()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('settings.assistant.form.errors.saveFailed'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form id={FORM_ID} onSubmit={handleSubmit} noValidate className="space-y-5">
      <FormSection title={t('settings.assistant.form.sectionName')}>
        <div>
          <Label htmlFor="ai-name">{t('settings.assistant.form.nameLabel')}</Label>
          <Input
            id="ai-name"
            value={form.name}
            aria-invalid={!!form.nameError}
            onChange={(e) => form.setName(e.target.value)}
            placeholder={t('settings.assistant.form.namePlaceholder')}
            className={`mt-1 ${FIELD_CLASS}`}
          />
          <FieldError message={form.nameError && t(form.nameError)} />
        </div>
      </FormSection>

      <div className="flex items-center justify-between rounded-lg border border-brand-100 px-3 py-2.5">
        <div>
          <Label className="font-normal text-brand-700">{form.isActive ? t('settings.assistant.form.activeLabel') : t('settings.assistant.form.inactiveLabel')}</Label>
          <p className="text-xs text-brand-400">{form.isActive ? t('settings.assistant.form.activeDescription') : t('settings.assistant.form.inactiveDescription')}</p>
        </div>
        <Switch checked={form.isActive} onCheckedChange={form.setIsActive} />
      </div>

      <FormSection title={t('settings.assistant.form.sectionModel')}>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="ai-provider">{t('settings.assistant.form.providerLabel')}</Label>
            <Select value={form.provider} onValueChange={(v) => form.setProvider(v as typeof form.provider)}>
              <SelectTrigger id="ai-provider" className={`mt-1 w-full ${FIELD_CLASS}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(['openai', 'gemini'] as const).map((p) => (
                  <SelectItem key={p} value={p} className="text-xs">
                    {t(PROVIDER_KEY[p])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label>{t('settings.assistant.form.modelLabel')}</Label>
            <div className="mt-1">
              <ComboboxFilter
                options={form.modelsForProvider.map((m) => ({ id: m.model_code, label: m.display_name }))}
                value={form.model || null}
                onChange={(id) => form.setModel(id ?? '')}
                placeholder={t('common.form.selectPlaceholder')}
                searchPlaceholder={t('common.form.selectPlaceholder')}
                emptyLabel={t('tasks.filter.noResults')}
                className="w-full"
                triggerClassName={COMBOBOX_TRIGGER_CLASS}
              />
            </div>
            <FieldError message={form.modelError && t(form.modelError)} />
          </div>
        </div>
      </FormSection>

      <FormSection title={t('settings.assistant.form.sectionInstructions')}>
        <div>
          <Label htmlFor="ai-system-prompt">{t('settings.assistant.form.systemPromptLabel')}</Label>
          <Textarea
            id="ai-system-prompt"
            rows={6}
            value={form.systemPrompt}
            aria-invalid={!!form.systemPromptError}
            onChange={(e) => form.setSystemPrompt(e.target.value)}
            placeholder={t('settings.assistant.form.systemPromptPlaceholder')}
            className={`mt-1 ${TEXTAREA_CLASS}`}
          />
          <FieldError message={form.systemPromptError && t(form.systemPromptError)} />
          <p className="mt-1.5 text-xs text-brand-400">{t('settings.assistant.form.systemPromptHint')}</p>
        </div>
      </FormSection>

      <FormSection title={t('settings.assistant.form.sectionBehavior')}>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="ai-temperature">{t('settings.assistant.form.temperatureLabel')}</Label>
            <Input
              id="ai-temperature"
              type="number"
              min={0}
              max={2}
              step={0.1}
              value={form.temperature}
              aria-invalid={!!form.temperatureError}
              onChange={(e) => form.setTemperature(Number(e.target.value))}
              className={`mt-1 ${FIELD_CLASS}`}
            />
            <FieldError message={form.temperatureError && t(form.temperatureError)} />
            <p className="mt-1 text-xs text-brand-400">{t('settings.assistant.form.temperatureHint')}</p>
          </div>

          <div>
            <Label htmlFor="ai-max-tokens">{t('settings.assistant.form.maxTokensLabel')}</Label>
            <Input
              id="ai-max-tokens"
              type="number"
              min={1}
              max={8192}
              step={1}
              value={form.maxTokens}
              aria-invalid={!!form.maxTokensError}
              onChange={(e) => form.setMaxTokens(Number(e.target.value))}
              className={`mt-1 ${FIELD_CLASS}`}
            />
            <FieldError message={form.maxTokensError && t(form.maxTokensError)} />
          </div>
        </div>
      </FormSection>

      {formError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</p>}
    </form>
  )
}
