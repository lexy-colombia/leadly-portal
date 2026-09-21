import { useCallback, useEffect, useState } from 'react'
import { useLanguage } from '../../contexts/LanguageContext'
import { Button } from '@/components/ui/button'
import { useAuth } from '../../contexts/AuthContext'
import { getTenant } from '../../lib/api/tenants'
import type { Tenant } from '../../types/domain'
import { PageSpinner } from '@/components/atoms'
import { PosFastCheckout } from './pos/PosFastCheckout'
import { PosOpenTabs } from './pos/PosOpenTabs'

/** Punto de entrada del POS -- decide entre los dos modos según
 * tenant.pos_allow_open_tabs (opt-in, apagado por default). Apagado:
 * venta rápida de un solo viaje (PosFastCheckout, sin cambios respecto a
 * lo ya construido). Encendido: cuentas abiertas (PosOpenTabs) -- un
 * segundo modo aditivo, pos-checkout y PosFastCheckout no se tocan en
 * ningún caso. */
export function Pos() {
  const { profile } = useAuth()
  const tenantId = profile?.tenant_id ?? null
  const { t } = useLanguage()
  const [tenant, setTenant] = useState<Tenant | null | undefined>(undefined)
  // Si getTenant falla NO se asume un modo: un tenant con cuentas abiertas
  // vendería por el flujo equivocado sin ningún aviso. Se muestra el error con
  // reintento.
  const [loadFailed, setLoadFailed] = useState(false)

  const load = useCallback(() => {
    if (!tenantId) return
    setLoadFailed(false)
    setTenant(undefined)
    getTenant(tenantId)
      .then((tn) => (tn ? setTenant(tn) : setLoadFailed(true)))
      .catch(() => setLoadFailed(true))
  }, [tenantId])

  useEffect(() => {
    load()
  }, [load])

  if (loadFailed) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center">
        <p className="text-sm text-red-700">{t('pos.mode.loadError')}</p>
        <Button type="button" variant="outline" onClick={load}>
          {t('common.actions.retry')}
        </Button>
      </div>
    )
  }
  if (!tenantId || tenant === undefined) return <PageSpinner />
  return tenant?.pos_allow_open_tabs ? <PosOpenTabs tenantId={tenantId} /> : <PosFastCheckout />
}
