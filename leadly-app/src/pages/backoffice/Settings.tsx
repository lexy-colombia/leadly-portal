import { useEffect, useState, type FormEvent } from 'react'
import { hasPlatformAiKey, setPlatformAiKey, type AiKeyProvider } from '../../lib/api/platformAiKeys'
import { Badge, Button, Input, Label } from '@/components/atoms'
import { Card, CardSection } from '@/components/molecules'
import { useLanguage } from '../../contexts/LanguageContext'
import type { TranslationKey } from '../../i18n/translations'

const PROVIDER_LABEL: Record<AiKeyProvider, string> = { openai: 'OpenAI', gemini: 'Google Gemini' }
const PROVIDER_HINT_KEY: Record<AiKeyProvider, TranslationKey> = {
  openai: 'backoffice.configuracion.hint.openai',
  gemini: 'backoffice.configuracion.hint.gemini',
}

function ProviderKeyCard({ provider }: { provider: AiKeyProvider }) {
  const { t } = useLanguage()
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [keyInput, setKeyInput] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [success, setSuccess] = useState(false)

  function reload() {
    hasPlatformAiKey(provider)
      .then(setConfigured)
      .catch((err) => setError(err.message ?? t('backoffice.configuracion.errors.status')))
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
      setError(err instanceof Error ? err.message : t('backoffice.configuracion.errors.save'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <CardSection
      title={PROVIDER_LABEL[provider]}
      action={
        configured !== null && (
          <Badge tone={configured ? 'success' : 'warning'}>
            {configured ? t('backoffice.configuracion.configured') : t('backoffice.configuracion.notConfigured')}
          </Badge>
        )
      }
    >
      <p className="mb-3 text-sm text-brand-400">{t(PROVIDER_HINT_KEY[provider])}</p>
      <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3">
        <div className="min-w-[240px] flex-1">
          <Label htmlFor={`key-${provider}`}>{configured ? t('backoffice.configuracion.apiKey.replace') : t('backoffice.configuracion.apiKey')}</Label>
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
          {submitting ? t('common.actions.saving') : t('common.actions.save')}
        </Button>
      </form>
      {success && <p className="mt-2 text-xs text-emerald-600">{t('backoffice.configuracion.saved')}</p>}
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </CardSection>
  )
}

export function Settings() {
  return (
    <div className="space-y-4">
      <Card padded={false}>
        <ProviderKeyCard provider="openai" />
        <ProviderKeyCard provider="gemini" />
      </Card>
    </div>
  )
}
