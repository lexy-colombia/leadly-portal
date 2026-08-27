import { useEffect, useState } from 'react'
import { getPaymentCredentialStatus, setPaymentCredentialSecret, setPaymentMode } from '../../../lib/api/billing'
import { FieldError } from '@/components/atoms'
import { Drawer } from '@/components/organisms'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { IntegrationStatusBanner } from './IntegrationStatusBanner'
import { IntegrationFieldLabel, IntegrationSection } from './IntegrationFieldLabel'
import { useLanguage } from '../../../contexts/LanguageContext'

const FIELD_CLASS = '!h-7 !rounded-lg !text-xs'

/** Wompi is not mapped-only like the others -- it's the real, working
 * payment system already powering invoice checkout/webhooks. It reads/writes
 * tenant_payment_credentials (not integration_credentials) via the same
 * functions billing.ts already exposed for the platform's own Wompi account
 * -- tenantId null there means Leadly's own merchant credential, a set
 * tenantId means that tenant's own. Shared between the backoffice (platform
 * account) and each tenant's own Integrations page (their own account). */
export function WompiIntegrationDrawer({
  open,
  onClose,
  tenantId,
  description,
}: {
  open: boolean
  onClose: () => void
  tenantId: string | null
  description: string
}) {
  const { t } = useLanguage()
  const [mode, setModeState] = useState<'sandbox' | 'production'>('sandbox')
  const [configuredSecrets, setConfiguredSecrets] = useState<string[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [privateKey, setPrivateKey] = useState('')
  const [integrityKey, setIntegrityKey] = useState('')
  const [eventsKey, setEventsKey] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [saved, setSaved] = useState(false)

  function reload() {
    getPaymentCredentialStatus(tenantId)
      .then((status) => {
        setModeState(status.mode)
        setConfiguredSecrets(status.configuredSecrets)
        setLoaded(true)
      })
      .catch((err) => setError(err.message ?? t('integrations.errors.load')))
  }

  useEffect(() => {
    if (!open) return
    setLoaded(false)
    setError(null)
    setSaved(false)
    setPrivateKey('')
    setIntegrityKey('')
    setEventsKey('')
    reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tenantId])

  async function handleModeChange(next: 'sandbox' | 'production') {
    setError(null)
    try {
      await setPaymentMode(tenantId, next)
      setModeState(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('integrations.errors.save'))
    }
  }

  async function handleSubmit() {
    if (!privateKey.trim() && !integrityKey.trim() && !eventsKey.trim()) return
    setSubmitting(true)
    setError(null)
    setSaved(false)
    try {
      if (privateKey.trim()) await setPaymentCredentialSecret(tenantId, 'private_key', privateKey.trim())
      if (integrityKey.trim()) await setPaymentCredentialSecret(tenantId, 'integrity_key', integrityKey.trim())
      if (eventsKey.trim()) await setPaymentCredentialSecret(tenantId, 'events_key', eventsKey.trim())
      setPrivateKey('')
      setIntegrityKey('')
      setEventsKey('')
      setSaved(true)
      reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('integrations.errors.save'))
    } finally {
      setSubmitting(false)
    }
  }

  const privateKeyConfigured = configuredSecrets.includes('private_key')
  const integrityKeyConfigured = configuredSecrets.includes('integrity_key')
  const eventsKeyConfigured = configuredSecrets.includes('events_key')
  // La conexión funcional solo depende de private_key (crear el link de
  // cobro) + events_key (validar el webhook que confirma el pago) -- el link
  // de pago se crea server-side vía la API de Payment Links, que nunca manda
  // un signature:integrity, así que integrity_key no tiene ningún efecto real
  // hoy (se deja como campo opcional para un futuro flujo de Web Checkout).
  const fullyConfigured = privateKeyConfigured && eventsKeyConfigured

  return (
    <Drawer open={open} onClose={onClose} title="Wompi" description={description}>
      {!loaded && !error && <p className="text-sm text-brand-400">{t('common.status.loading')}</p>}

      {loaded && (
        <div className="space-y-4">
          <IntegrationStatusBanner
            connected={fullyConfigured}
            connectedText={t('integrations.wompi.connected')}
            notConnectedText={t('integrations.wompi.notConnected')}
          />

          <IntegrationSection title={t('integrations.section.credentials')}>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <IntegrationFieldLabel
                  htmlFor="wompi-integration-private-key"
                  label={t('integrations.privateKey')}
                  badge={
                    privateKeyConfigured && (
                      <Badge variant="outline" className="border-transparent bg-emerald-100 text-emerald-700">
                        {t('integrations.configured')}
                      </Badge>
                    )
                  }
                />
                <Input
                  id="wompi-integration-private-key"
                  type="password"
                  value={privateKey}
                  onChange={(e) => setPrivateKey(e.target.value)}
                  placeholder={privateKeyConfigured ? t('integrations.replaceValue') : 'prv_...'}
                  autoComplete="off"
                  className={FIELD_CLASS}
                />
              </div>
              <div>
                <IntegrationFieldLabel
                  htmlFor="wompi-integration-integrity-key"
                  label={t('integrations.integrityKey')}
                  badge={
                    integrityKeyConfigured && (
                      <Badge variant="outline" className="border-transparent bg-emerald-100 text-emerald-700">
                        {t('integrations.configured')}
                      </Badge>
                    )
                  }
                />
                <Input
                  id="wompi-integration-integrity-key"
                  type="password"
                  value={integrityKey}
                  onChange={(e) => setIntegrityKey(e.target.value)}
                  placeholder={integrityKeyConfigured ? t('integrations.replaceValue') : undefined}
                  autoComplete="off"
                  className={FIELD_CLASS}
                />
              </div>
              <div>
                <IntegrationFieldLabel
                  htmlFor="wompi-integration-events-key"
                  label={t('integrations.eventsKey')}
                  badge={
                    eventsKeyConfigured && (
                      <Badge variant="outline" className="border-transparent bg-emerald-100 text-emerald-700">
                        {t('integrations.configured')}
                      </Badge>
                    )
                  }
                />
                <Input
                  id="wompi-integration-events-key"
                  type="password"
                  value={eventsKey}
                  onChange={(e) => setEventsKey(e.target.value)}
                  placeholder={eventsKeyConfigured ? t('integrations.replaceValue') : undefined}
                  autoComplete="off"
                  className={FIELD_CLASS}
                />
                <p className="mt-1 text-[11px] text-brand-400">{t('integrations.eventsKeyHint')}</p>
              </div>
            </div>
          </IntegrationSection>

          <IntegrationSection title={t('integrations.section.settings')}>
            <div className="max-w-[200px]">
              <IntegrationFieldLabel htmlFor="wompi-integration-mode" label={t('integrations.mode')} />
              <Select value={mode} onValueChange={(v) => handleModeChange(v as 'sandbox' | 'production')}>
                <SelectTrigger id="wompi-integration-mode" className={`w-full ${FIELD_CLASS}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="sandbox" className="text-xs">
                    {t('integrations.mode.sandbox')}
                  </SelectItem>
                  <SelectItem value="production" className="text-xs">
                    {t('integrations.mode.production')}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </IntegrationSection>

          {error && <FieldError message={error} />}

          <div className="flex items-center gap-2 border-t border-brand-100 pt-4">
            <Button type="button" onClick={handleSubmit} disabled={submitting || (!privateKey.trim() && !integrityKey.trim() && !eventsKey.trim())}>
              {submitting ? t('common.actions.saving') : t('common.actions.save')}
            </Button>
            {saved && <span className="text-xs text-emerald-600">{t('integrations.configSaved')}</span>}
          </div>
        </div>
      )}
    </Drawer>
  )
}
