import { IntegrationsGrid } from '../shared/integrations/IntegrationsGrid'
import { useLanguage } from '../../contexts/LanguageContext'

/** Platform-level only: everything configured here is Leadly's own account
 * with each provider (tenantId null), not a given tenant's -- see the
 * tenant's own /app/integrations for that. The card grid + drawers
 * themselves live in IntegrationsGrid, shared between both screens. */
export function Integrations() {
  const { t } = useLanguage()

  return (
    <div className="animate-fade-in space-y-4">
      <IntegrationsGrid tenantId={null} drawerDescription={t('integrations.drawer.scopePlatform')} />
    </div>
  )
}
