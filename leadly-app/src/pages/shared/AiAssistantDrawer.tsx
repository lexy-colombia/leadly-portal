import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { createAiAssistant, getAiAssistant, updateAiAssistant } from '../../lib/api/aiAssistants'
import { listAiModels } from '../../lib/api/aiModels'
import { listAiSkills, listEnabledSkillKeys, setSkillEnabled } from '../../lib/api/aiSkills'
import type { AiAssistant, AiModel, AiProvider, AiSkill } from '../../types/domain'
import { useAuth } from '../../contexts/AuthContext'
import { Badge, Button, Drawer, FieldError, Input, Label, PageSpinner, Select, Switch, Textarea } from '../../components/ui'
import { useAiAssistantForm } from './useAiAssistantForm'

const PROVIDER_LABEL: Record<AiProvider, string> = { openai: 'OpenAI (ChatGPT)', gemini: 'Google (Gemini)' }

const FORM_ID = 'ai-assistant-form'

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
        .catch((err) => setLoadError(err.message ?? 'No se pudieron cargar los modelos.'))
      return
    }
    setAssistant(undefined)
    Promise.all([getAiAssistant(assistantId), listAiModels()])
      .then(([a, m]) => {
        setAssistant(a)
        setModels(m)
      })
      .catch((err) => setLoadError(err.message ?? 'No se pudo cargar el agente.'))
  }, [open, assistantId, isCreating])

  const loading = !models || (!isCreating && assistant === undefined)
  const ready = !loadError && !loading

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={isCreating ? 'Nuevo agente' : 'Agente de IA'}
      description={isCreating ? 'Configura una persona de IA reutilizable en cualquiera de tus líneas.' : (assistant?.name ?? '')}
      footer={
        ready ? (
          <div className="flex gap-2">
            <Button type="submit" form={FORM_ID} variant="secondary" disabled={submitting}>
              {submitting ? 'Guardando…' : isCreating ? 'Crear agente' : 'Guardar cambios'}
            </Button>
            <Button type="button" variant="ghost" onClick={onClose} disabled={submitting}>
              Cancelar
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
      .catch((err) => setError(err.message ?? 'No se pudieron cargar las habilidades.'))
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
      setError(err instanceof Error ? err.message : 'No se pudo actualizar la habilidad.')
    } finally {
      setTogglingKey(null)
    }
  }

  return (
    <div className="mt-6 space-y-3 border-t border-brand-100 pt-6">
      <FormSection title="Habilidades">
        <p className="-mt-1 text-xs text-brand-400">
          {readOnly
            ? 'Qué puede hacer tu IA además de conversar -- lo habilita Leadly según tu plan.'
            : 'Qué puede hacer la IA además de conversar -- cada una agrega herramientas reales (no solo texto) y sus instrucciones de uso al system prompt.'}
        </p>
        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        {!skills && !error && <PageSpinner />}
        {skills && skills.length === 0 && <p className="text-sm text-brand-400">Todavía no hay habilidades en el catálogo.</p>}
        {readOnly && skills && skills.length > 0 && enabledKeys.size === 0 && (
          <p className="text-sm text-brand-400">Tu plan todavía no tiene ninguna habilidad activa.</p>
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
                      <Badge tone="success">Activa</Badge>
                    ) : (
                      <Switch checked={enabled} disabled={togglingKey === skill.key} onChange={(v) => handleToggle(skill.key, v)} />
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
      setFormError(err instanceof Error ? err.message : 'No se pudo guardar el agente.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form id={FORM_ID} onSubmit={handleSubmit} noValidate className="space-y-6">
      <FormSection title="Nombre">
        <div>
          <Label htmlFor="ai-name">Nombre del agente</Label>
          <Input
            id="ai-name"
            value={form.name}
            invalid={!!form.nameError}
            onChange={(e) => form.setName(e.target.value)}
            placeholder="Ej: Agente de Ventas"
          />
          <FieldError message={form.nameError} />
        </div>
      </FormSection>

      <div className="flex items-center justify-between rounded-xl bg-brand-50 px-4 py-3">
        <div>
          <p className="text-sm font-medium text-brand-800">{form.isActive ? 'Asistente activo' : 'Asistente inactivo'}</p>
          <p className="text-xs text-brand-400">
            {form.isActive ? 'Responde automáticamente en modo IA.' : 'No responde hasta que lo actives.'}
          </p>
        </div>
        <Switch checked={form.isActive} onChange={form.setIsActive} />
      </div>

      <FormSection title="Modelo de IA">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="ai-provider">Proveedor</Label>
            <Select id="ai-provider" value={form.provider} onChange={(e) => form.setProvider(e.target.value as typeof form.provider)}>
              {(['openai', 'gemini'] as const).map((p) => (
                <option key={p} value={p}>
                  {PROVIDER_LABEL[p]}
                </option>
              ))}
            </Select>
          </div>

          <div>
            <Label htmlFor="ai-model">Modelo</Label>
            <Select id="ai-model" value={form.model} invalid={!!form.modelError} onChange={(e) => form.setModel(e.target.value)}>
              <option value="">Selecciona…</option>
              {form.modelsForProvider.map((m) => (
                <option key={m.model_code} value={m.model_code}>
                  {m.display_name}
                </option>
              ))}
            </Select>
            <FieldError message={form.modelError} />
          </div>
        </div>
      </FormSection>

      <FormSection title="Instrucciones">
        <div>
          <Label htmlFor="ai-system-prompt">System prompt</Label>
          <Textarea
            id="ai-system-prompt"
            rows={8}
            value={form.systemPrompt}
            invalid={!!form.systemPromptError}
            onChange={(e) => form.setSystemPrompt(e.target.value)}
            placeholder="Eres el asistente de [tu empresa]. Ayudas a los clientes con... Responde solo sobre [tema/alcance del negocio]."
          />
          <FieldError message={form.systemPromptError} />
          <p className="mt-1.5 text-xs text-brand-400">
            Mantén el asistente enfocado en tu negocio (soporte, ventas, agendamiento). Configurarlo como un asistente de propósito
            general (tipo ChatGPT, sin límite de tema) va contra la política de WhatsApp y puede hacer que Meta suspenda la línea.
          </p>
        </div>
      </FormSection>

      <FormSection title="Comportamiento">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="ai-temperature">Temperatura</Label>
            <Input
              id="ai-temperature"
              type="number"
              min={0}
              max={2}
              step={0.1}
              value={form.temperature}
              invalid={!!form.temperatureError}
              onChange={(e) => form.setTemperature(Number(e.target.value))}
            />
            <FieldError message={form.temperatureError} />
            <p className="mt-1 text-xs text-brand-400">0 = más literal, 2 = más creativo.</p>
          </div>

          <div>
            <Label htmlFor="ai-max-tokens">Máx. tokens por respuesta</Label>
            <Input
              id="ai-max-tokens"
              type="number"
              min={1}
              max={8192}
              step={1}
              value={form.maxTokens}
              invalid={!!form.maxTokensError}
              onChange={(e) => form.setMaxTokens(Number(e.target.value))}
            />
            <FieldError message={form.maxTokensError} />
          </div>
        </div>
      </FormSection>

      {formError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</p>}
    </form>
  )
}
