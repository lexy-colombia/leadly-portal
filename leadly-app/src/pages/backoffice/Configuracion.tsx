import { useEffect, useState, type FormEvent } from 'react'
import { hasPlatformAiKey, setPlatformAiKey, type AiKeyProvider } from '../../lib/api/platformAiKeys'
import { Badge, Button, Card, CardSection, Input, Label } from '../../components/ui'
import { KeyIcon } from '../../components/icons'

const PROVIDER_LABEL: Record<AiKeyProvider, string> = { openai: 'OpenAI', gemini: 'Google Gemini' }
const PROVIDER_HINT: Record<AiKeyProvider, string> = {
  openai: 'Se usa para todos los asistentes configurados con proveedor OpenAI (GPT).',
  gemini: 'Se usa para todos los asistentes configurados con proveedor Gemini.',
}

function ProviderKeyCard({ provider }: { provider: AiKeyProvider }) {
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [keyInput, setKeyInput] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [success, setSuccess] = useState(false)

  function reload() {
    hasPlatformAiKey(provider)
      .then(setConfigured)
      .catch((err) => setError(err.message ?? 'No se pudo consultar el estado de la key.'))
  }

  useEffect(reload, [provider])

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!keyInput.trim()) return
    setSubmitting(true)
    setError(null)
    setSuccess(false)
    try {
      await setPlatformAiKey(provider, keyInput.trim())
      setKeyInput('')
      setSuccess(true)
      reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo guardar la key.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <CardSection
      title={PROVIDER_LABEL[provider]}
      action={
        configured !== null && (
          <Badge tone={configured ? 'success' : 'warning'}>{configured ? 'Configurada' : 'Sin configurar'}</Badge>
        )
      }
    >
      <p className="mb-3 text-sm text-brand-400">{PROVIDER_HINT[provider]}</p>
      <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3">
        <div className="min-w-[240px] flex-1">
          <Label htmlFor={`key-${provider}`}>{configured ? 'Reemplazar API key' : 'API key'}</Label>
          <Input
            id={`key-${provider}`}
            type="password"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            placeholder={provider === 'openai' ? 'sk-...' : 'AIza...'}
            autoComplete="off"
          />
        </div>
        <Button type="submit" variant="secondary" disabled={submitting || !keyInput.trim()}>
          {submitting ? 'Guardando…' : 'Guardar'}
        </Button>
      </form>
      {success && <p className="mt-2 text-xs text-emerald-600">Key guardada correctamente.</p>}
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </CardSection>
  )
}

export function Configuracion() {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent-50 text-accent-600">
          <KeyIcon width={18} height={18} />
        </span>
        <div>
          <h1 className="text-xl font-bold text-brand-800 sm:text-2xl">Configuración de IA</h1>
          <p className="text-sm text-brand-400">API keys usadas por todos los asistentes de todos los clientes.</p>
        </div>
      </div>

      <Card padded={false}>
        <ProviderKeyCard provider="openai" />
        <ProviderKeyCard provider="gemini" />
      </Card>
    </div>
  )
}
