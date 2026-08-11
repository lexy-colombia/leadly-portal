import { useAuth } from '../../contexts/AuthContext'
import { useLanguage } from '../../contexts/LanguageContext'
import { IntegrationsGrid } from '../shared/integrations/IntegrationsGrid'
import { Card } from '../../components/ui'
import { LockClosedIcon } from '../../components/icons'

/** Each tenant's own third-party integrations (LaFactura/Wompi/Shopify/
 * HubSpot) -- their own accounts with each provider, kept separate from the
 * backoffice's Integraciones (Leadly's own accounts) by tenant_id scoping on
 * integration_credentials/tenant_payment_credentials. Same card grid +
 * drawers as the backoffice screen (IntegrationsGrid), admin-gated the same
 * way as Configuracion.tsx/IaAgentes.tsx -- credentials are sensitive, a
 * tenant_agent shouldn't manage them. */
export function Integraciones() {
  const { profile } = useAuth()
  const { t } = useLanguage()
  const isAdmin = profile?.role === 'tenant_admin'

  return (
    <div className="animate-fade-in space-y-4">
      <h1 className="text-xl font-bold text-brand-800 sm:text-2xl">{t('integrations.title')}</h1>

      {isAdmin && profile?.tenant_id ? (
        <IntegrationsGrid tenantId={profile.tenant_id} drawerDescription={t('integrations.drawer.scopeTenant')} />
      ) : (
        <Card>
          <div className="flex flex-col items-center gap-3 px-4 py-14 text-center">
            <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-50 text-brand-300">
              <LockClosedIcon width={26} height={26} />
            </span>
            <p className="max-w-sm text-sm text-brand-400">{t('integrations.adminOnly')}</p>
          </div>
        </Card>
      )}
    </div>
  )
}
