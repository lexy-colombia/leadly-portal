import { useEffect, useState } from 'react'
import { getPaymentCredentialStatus } from '../../../lib/api/billing'
import { getIntegrationCredential, getIntegrationCredentialConfiguredSecrets, listIntegrationProviders } from '../../../lib/api/integrations'
import type { IntegrationCategory, IntegrationProvider } from '../../../types/domain'
import { Badge, PageSpinner } from '@/components/atoms'
import { Card } from '@/components/molecules'
import { GlobeIcon } from '@/components/atoms/icons'
import { LaFacturaCredentialDrawer } from './LaFacturaCredentialDrawer'
import { WompiIntegrationDrawer } from './WompiIntegrationDrawer'
import { ShopifyCredentialDrawer } from './ShopifyCredentialDrawer'
import { HubSpotCredentialDrawer } from './HubSpotCredentialDrawer'
import { useLanguage } from '../../../contexts/LanguageContext'
import type { TranslationKey } from '../../../i18n/translations'

const CATEGORY_LABEL_KEY: Record<IntegrationCategory, TranslationKey> = {
  invoicing: 'integrations.category.invoicing',
  accounting: 'integrations.category.accounting',
  messaging: 'integrations.category.messaging',
  payments: 'integrations.category.payments',
  crm: 'integrations.category.crm',
  ecommerce: 'integrations.category.ecommerce',
  other: 'integrations.category.other',
}

// Providers with their own brand mark (public/integrations/<key>.png|svg) --
// falls back to the generic GlobeIcon for anything without one yet.
const PROVIDER_LOGO: Record<string, string> = {
  lafactura: '/integrations/lafactura.png',
  wompi: '/integrations/wompi.svg',
  shopify: '/integrations/shopify.png',
  hubspot: '/integrations/hubspot.png',
}

/** Whether a credential row plus at least one secret exists for this
 * provider -- a good-enough "connected" proxy for the card grid; each
 * drawer's own status banner is the precise, per-field check. */
async function checkConnected(providerKey: string, tenantId: string | null): Promise<boolean> {
  if (providerKey === 'wompi') {
    const status = await getPaymentCredentialStatus(tenantId)
    return status.configuredSecrets.includes('private_key') && status.configuredSecrets.includes('integrity_key')
  }
  const credential = await getIntegrationCredential(providerKey, tenantId)
  if (!credential) return false
  const secrets = await getIntegrationCredentialConfiguredSecrets(credential.id)
  return secrets.length > 0
}

/** Card grid + drawers for the third-party integrations catalog
 * (LaFactura/Wompi/Shopify/HubSpot today). Shared between the backoffice
 * (tenantId null -- Leadly's own accounts with each provider) and each
 * tenant's own Integrations page (tenantId set -- that tenant's own
 * accounts) -- same catalog, same drawers, different credential rows
 * underneath (see integration_credentials/tenant_payment_credentials'
 * tenant_id-nullable scoping). */
export function IntegrationsGrid({ tenantId, drawerDescription }: { tenantId: string | null; drawerDescription: string }) {
  const { t } = useLanguage()
  const [providers, setProviders] = useState<IntegrationProvider[] | null>(null)
  const [connectedByKey, setConnectedByKey] = useState<Record<string, boolean>>({})
  const [error, setError] = useState<string | null>(null)
  const [drawerProvider, setDrawerProvider] = useState<IntegrationProvider | null>(null)

  useEffect(() => {
    listIntegrationProviders()
      .then(setProviders)
      .catch((err) => setError(err.message ?? t('integrations.errors.load')))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!providers) return
    let cancelled = false
    Promise.all(providers.map(async (p) => [p.key, await checkConnected(p.key, tenantId).catch(() => false)] as const)).then((entries) => {
      if (!cancelled) setConnectedByKey(Object.fromEntries(entries))
    })
    return () => {
      cancelled = true
    }
  }, [providers, tenantId])

  function refreshConnection(providerKey: string) {
    checkConnected(providerKey, tenantId)
      .then((connected) => setConnectedByKey((prev) => ({ ...prev, [providerKey]: connected })))
      .catch(() => {})
  }

  function closeDrawer() {
    if (drawerProvider) refreshConnection(drawerProvider.key)
    setDrawerProvider(null)
  }

  return (
    <div className="space-y-4">
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {!providers && !error && <PageSpinner />}

      {providers && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {providers.map((provider) => {
            const connected = connectedByKey[provider.key] ?? false
            return (
              <button key={provider.key} type="button" onClick={() => setDrawerProvider(provider)} className="text-left">
                <Card hover className={connected ? '!border-emerald-200 !bg-emerald-50/40' : undefined}>
                  <div className="flex items-center gap-3">
                    <span className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-white ring-1 ring-brand-100">
                      {PROVIDER_LOGO[provider.key] ? (
                        <img src={PROVIDER_LOGO[provider.key]} alt="" className="h-7 w-7 object-contain" />
                      ) : (
                        <GlobeIcon width={18} height={18} className="text-accent-600" />
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-brand-800">{provider.name}</p>
                      <Badge tone="neutral">{t(CATEGORY_LABEL_KEY[provider.category])}</Badge>
                    </div>
                  </div>
                  {provider.description && <p className="mt-3 text-xs text-brand-400">{provider.description}</p>}
                  <div className="mt-3 flex items-center gap-1.5 border-t border-brand-100 pt-3 text-xs font-medium">
                    <span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-emerald-500' : 'bg-brand-300'}`} />
                    <span className={connected ? 'text-emerald-700' : 'text-brand-400'}>
                      {connected ? t('integrations.connected') : t('integrations.notConnected')}
                    </span>
                  </div>
                </Card>
              </button>
            )
          })}
        </div>
      )}

      {drawerProvider?.key === 'wompi' && <WompiIntegrationDrawer open onClose={closeDrawer} tenantId={tenantId} description={drawerDescription} />}
      {drawerProvider?.key === 'lafactura' && <LaFacturaCredentialDrawer open onClose={closeDrawer} tenantId={tenantId} description={drawerDescription} />}
      {drawerProvider?.key === 'shopify' && <ShopifyCredentialDrawer open onClose={closeDrawer} tenantId={tenantId} description={drawerDescription} />}
      {drawerProvider?.key === 'hubspot' && <HubSpotCredentialDrawer open onClose={closeDrawer} tenantId={tenantId} description={drawerDescription} />}
    </div>
  )
}
