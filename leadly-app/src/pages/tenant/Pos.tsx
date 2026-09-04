import { useEffect, useState } from 'react'
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
  const [tenant, setTenant] = useState<Tenant | null | undefined>(undefined)

  useEffect(() => {
    if (!tenantId) return
    getTenant(tenantId).then(setTenant).catch(() => setTenant(null))
  }, [tenantId])

  if (!tenantId || tenant === undefined) return <PageSpinner />
  return tenant?.pos_allow_open_tabs ? <PosOpenTabs tenantId={tenantId} /> : <PosFastCheckout />
}
