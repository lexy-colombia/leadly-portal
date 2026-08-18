import { useEffect, useState } from 'react'
import { getIntegrationCredential, getIntegrationCredentialConfiguredSecrets, setIntegrationCredentialSecret } from '../../../lib/api/integrations'
import { FieldError } from '@/components/atoms'
import { Drawer } from '@/components/organisms'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { IntegrationStatusBanner } from './IntegrationStatusBanner'
import { IntegrationFieldLabel, IntegrationSection } from './IntegrationFieldLabel'
import { useLanguage } from '../../../contexts/LanguageContext'

const PROVIDER_KEY = 'hubspot'
const FIELD_CLASS = '!h-7 !rounded-lg !text-xs'

/** Just the Private App Token -- HubSpot's simplest auth method (no OAuth
 * app registration needed, unlike Shopify). Mapped, not wired: no Edge
 * Function syncs contacts/deals yet. Shared between the backoffice (platform
 * account, tenantId null) and each tenant's own Integrations page (their
 * own account, tenantId set). */
export function HubSpotCredentialDrawer({
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
  const [token, setToken] = useState('')
  const [configuredSecrets, setConfiguredSecrets] = useState<string[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (!open) return
    setLoaded(false)
    setError(null)
    setSaved(false)
    setToken('')
    getIntegrationCredential(PROVIDER_KEY, tenantId)
      .then(async (credential) => {
        setConfiguredSecrets(credential ? await getIntegrationCredentialConfiguredSecrets(credential.id) : [])
        setLoaded(true)
      })
      .catch((err) => setError(err.message ?? t('integrations.errors.load')))
  }, [open, tenantId])

  async function handleSubmit() {
    if (!token.trim()) return
    setSubmitting(true)
    setError(null)
    setSaved(false)
    try {
      await setIntegrationCredentialSecret(PROVIDER_KEY, tenantId, 'token', token.trim())
      const credential = await getIntegrationCredential(PROVIDER_KEY, tenantId)
      setConfiguredSecrets(credential ? await getIntegrationCredentialConfiguredSecrets(credential.id) : [])
      setToken('')
      setSaved(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('integrations.errors.save'))
    } finally {
      setSubmitting(false)
    }
  }

  const tokenConfigured = configuredSecrets.includes('token')

  return (
    <Drawer open={open} onClose={onClose} title="HubSpot" description={description}>
      {!loaded && !error && <p className="text-sm text-brand-400">{t('common.status.loading')}</p>}

      {loaded && (
        <div className="space-y-4">
          <IntegrationStatusBanner connected={tokenConfigured} connectedText={t('integrations.hubspot.connected')} notConnectedText={t('integrations.hubspot.notConnected')} />

          <IntegrationSection title={t('integrations.section.credentials')}>
            <div>
              <IntegrationFieldLabel
                htmlFor="hubspot-token"
                label={t('integrations.hubspot.token')}
                badge={
                  tokenConfigured && (
                    <Badge variant="outline" className="border-transparent bg-emerald-100 text-emerald-700">
                      {t('integrations.configured')}
                    </Badge>
                  )
                }
              />
              <Input
                id="hubspot-token"
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder={tokenConfigured ? t('integrations.replaceValue') : 'pat-...'}
                autoComplete="off"
                className={FIELD_CLASS}
              />
              <p className="mt-1 text-xs text-brand-400">{t('integrations.hubspot.token.hint')}</p>
            </div>
          </IntegrationSection>

          {error && <FieldError message={error} />}

          <div className="flex items-center gap-2 border-t border-brand-100 pt-4">
            <Button type="button" onClick={handleSubmit} disabled={submitting || !token.trim()}>
              {submitting ? t('common.actions.saving') : t('common.actions.save')}
            </Button>
            {saved && <span className="text-xs text-emerald-600">{t('integrations.configSaved')}</span>}
          </div>
        </div>
      )}
    </Drawer>
  )
}
