import { useEffect, useState } from 'react'
import {
  getIntegrationCredential,
  getIntegrationCredentialConfiguredSecrets,
  setIntegrationCredentialConfig,
  setIntegrationCredentialSecret,
} from '../../../lib/api/integrations'
import { Badge, Button, FieldError, Input } from '@/components/atoms'
import { Drawer } from '@/components/organisms'
import { IntegrationStatusBanner } from './IntegrationStatusBanner'
import { IntegrationFieldLabel, IntegrationSection } from './IntegrationFieldLabel'
import { useLanguage } from '../../../contexts/LanguageContext'

const PROVIDER_KEY = 'shopify'

/** Shopify's own fields (store domain + Admin API access token) -- mapped,
 * not wired: no Edge Function syncs products/orders yet, this only saves
 * the account for when that's built (same "prepared, not connected"
 * treatment as LaFactura). Real Shopify OAuth (like tania-functions'
 * ShopifyConnection) needs a registered public app with redirect URIs --
 * out of scope until there's an actual product/order sync to build. Shared
 * between the backoffice (platform account, tenantId null) and each
 * tenant's own Integrations page (their own account, tenantId set). */
export function ShopifyCredentialDrawer({
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
  const [storeName, setStoreName] = useState('')
  const [accessToken, setAccessToken] = useState('')
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
    setAccessToken('')
    getIntegrationCredential(PROVIDER_KEY, tenantId)
      .then(async (credential) => {
        const config = (credential?.config ?? {}) as Record<string, unknown>
        setStoreName(typeof config.shop === 'string' ? config.shop : '')
        setConfiguredSecrets(credential ? await getIntegrationCredentialConfiguredSecrets(credential.id) : [])
        setLoaded(true)
      })
      .catch((err) => setError(err.message ?? t('integrations.errors.load')))
  }, [open, tenantId])

  async function handleSubmit() {
    setSubmitting(true)
    setError(null)
    setSaved(false)
    try {
      await setIntegrationCredentialConfig(PROVIDER_KEY, tenantId, { shop: storeName.trim() || null })
      if (accessToken.trim()) await setIntegrationCredentialSecret(PROVIDER_KEY, tenantId, 'access_token', accessToken.trim())

      const credential = await getIntegrationCredential(PROVIDER_KEY, tenantId)
      setConfiguredSecrets(credential ? await getIntegrationCredentialConfiguredSecrets(credential.id) : [])
      setAccessToken('')
      setSaved(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('integrations.errors.save'))
    } finally {
      setSubmitting(false)
    }
  }

  const tokenConfigured = configuredSecrets.includes('access_token')
  const connected = !!storeName.trim() && tokenConfigured

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Shopify"
      description={description}
    >
      {!loaded && !error && <p className="text-sm text-brand-400">{t('common.status.loading')}</p>}

      {loaded && (
        <div className="space-y-4">
          <IntegrationStatusBanner
            connected={connected}
            connectedText={t('integrations.shopify.connected')}
            notConnectedText={t('integrations.shopify.notConnected')}
          />

          <IntegrationSection title={t('integrations.section.credentials')}>
            <div>
              <IntegrationFieldLabel htmlFor="shopify-store" label={t('integrations.shopify.store')} />
              <div className="flex items-center gap-2">
                <Input id="shopify-store" value={storeName} onChange={(e) => setStoreName(e.target.value)} placeholder="mi-tienda" className="flex-1" />
                <span className="shrink-0 text-xs text-brand-400">.myshopify.com</span>
              </div>
            </div>

            <div>
              <IntegrationFieldLabel
                htmlFor="shopify-token"
                label={t('integrations.shopify.accessToken')}
                badge={tokenConfigured && <Badge tone="success">{t('integrations.configured')}</Badge>}
              />
              <Input
                id="shopify-token"
                type="password"
                value={accessToken}
                onChange={(e) => setAccessToken(e.target.value)}
                placeholder={tokenConfigured ? t('integrations.replaceValue') : 'shpat_...'}
                autoComplete="off"
              />
              <p className="mt-1 text-xs text-brand-400">{t('integrations.shopify.accessToken.hint')}</p>
            </div>
          </IntegrationSection>

          {error && <FieldError message={error} />}

          <div className="flex items-center gap-2 border-t border-brand-100 pt-4">
            <Button type="button" variant="secondary" onClick={handleSubmit} disabled={submitting}>
              {submitting ? t('common.actions.saving') : t('common.actions.save')}
            </Button>
            {saved && <span className="text-xs text-emerald-600">{t('integrations.configSaved')}</span>}
          </div>
        </div>
      )}
    </Drawer>
  )
}
