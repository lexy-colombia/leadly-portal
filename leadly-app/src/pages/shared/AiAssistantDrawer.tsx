import { useEffect, useState, type FormEvent } from 'react'
import { getAiAssistantByLine, updateAiAssistant } from '../../lib/api/aiAssistants'
import { listAiModels } from '../../lib/api/aiModels'
import type { AiAssistant, AiModel, AiProvider } from '../../types/domain'
import { useAuth } from '../../contexts/AuthContext'
import { Button, Drawer, FieldError, Input, Label, PageSpinner, Select, Switch, Textarea } from '../../components/ui'
import { useAiAssistantForm } from './useAiAssistantForm'

const PROVIDER_LABEL: Record<AiProvider, string> = { openai: 'OpenAI (ChatGPT)', gemini: 'Google (Gemini)' }

/** Shared between the backoffice (from a Cliente's Líneas section) and the
 * tenant panel (from "Asistente de IA") -- same config, same rules, only the
 * caller differs. Fetches its own data instead of taking it as a prop so
 * both call sites can just pass a whatsappLineId. */
export function AiAssistantDrawer({
  open,
  onClose,
  whatsappLineId,
  lineName,
}: {
  open: boolean
  onClose: () => void
  whatsappLineId: string
  lineName: string
}) {
  const { profile } = useAuth()
  const [assistant, setAssistant] = useState<AiAssistant | null | undefined>(undefined)
  const [models, setModels] = useState<AiModel[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setAssistant(undefined)
    setModels(null)
    setLoadError(null)
    Promise.all([getAiAssistantByLine(whatsappLineId), listAiModels()])
      .then(([a, m]) => {
        setAssistant(a)
        setModels(m)
      })
      .catch((err) => setLoadError(err.message ?? 'No se pudo cargar el asistente.'))
  }, [open, whatsappLineId])

  return (
    <Drawer open={open} onClose={onClose} title="Asistente de IA" description={lineName}>
      {loadError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{loadError}</p>}
      {!loadError && (assistant === undefined || !models) && <PageSpinner />}
      {!loadError && assistant === null && (
        <p className="text-sm text-brand-500">Esta línea todavía no tiene un asistente configurado.</p>
      )}
      {!loadError && assistant && models && (
        <AiAssistantDrawerForm assistant={assistant} models={models} updatedBy={profile?.id ?? ''} onClose={onClose} />
      )}
    </Drawer>
  )
}

function AiAssistantDrawerForm({
  assistant,
  models,
  updatedBy,
  onClose,
}: {
  assistant: AiAssistant
  models: AiModel[]
  updatedBy: string
  onClose: () => void
}) {
  const form = useAiAssistantForm(assistant, models)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    form.setTouched(true)
    setFormError(null)
    if (!form.isValid()) return

    setSubmitting(true)
    try {
      await updateAiAssistant(assistant.id, form.toInput(), updatedBy)
      onClose()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'No se pudo guardar el asistente.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-5">
      <Switch checked={form.isActive} onChange={form.setIsActive} label={form.isActive ? 'Asistente activo' : 'Asistente inactivo'} />

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

      {formError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</p>}

      <div className="flex gap-2 border-t border-brand-100 pt-5">
        <Button type="submit" variant="secondary" disabled={submitting}>
          {submitting ? 'Guardando…' : 'Guardar cambios'}
        </Button>
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancelar
        </Button>
      </div>
    </form>
  )
}
