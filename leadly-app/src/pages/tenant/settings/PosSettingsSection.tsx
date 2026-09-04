import { useState } from 'react'
import { updateTenantPosSettings } from '../../../lib/api/tenants'
import type { Tenant } from '../../../types/domain'
import { useLanguage } from '../../../contexts/LanguageContext'
import { Switch } from '@/components/atoms'
import { Card, CardSection } from '@/components/molecules'
import { PosPointsSection } from './PosPointsSection'

/** "Punto de venta" category -- cuentas abiertas (instant-apply switch) +
 * sus puntos de venta (mesas/cajas), que solo tienen sentido -- y solo se
 * muestran -- una vez que el interruptor está encendido. La impresión de
 * tickets vive aparte, en "Documentos y tickets" (DocumentsSection). */
export function PosSettingsSection({ tenant, onSaved }: { tenant: Tenant; onSaved: (tenant: Tenant) => void }) {
  const { t } = useLanguage()
  const [toggling, setToggling] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleToggle(enabled: boolean) {
    setToggling(true)
    setError(null)
    try {
      const updated = await updateTenantPosSettings(tenant.id, { pos_allow_open_tabs: enabled })
      onSaved(updated)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('settings.pos.errors.save'))
    } finally {
      setToggling(false)
    }
  }

  return (
    <Card padded={false}>
      <CardSection title={t('settings.pos.title')} description={t('settings.pos.description')}>
        <div className="space-y-3.5">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-brand-700">{t('settings.pos.openTabsLabel')}</p>
              <p className="text-xs text-brand-400">{t('settings.pos.openTabsDescription')}</p>
            </div>
            <Switch checked={tenant.pos_allow_open_tabs} disabled={toggling} onChange={handleToggle} />
          </div>

          {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

          {tenant.pos_allow_open_tabs && (
            <div className="border-t border-brand-100 pt-3.5">
              <p className="mb-2 text-sm font-medium text-brand-700">{t('settings.pos.pointsTitle')}</p>
              <PosPointsSection tenantId={tenant.id} />
            </div>
          )}
        </div>
      </CardSection>
    </Card>
  )
}
