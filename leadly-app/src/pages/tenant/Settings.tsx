import { useEffect, useState } from 'react'
import { Building2, FileText, RotateCcw, ShoppingCart, Store, Truck, Warehouse as WarehouseIcon } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { useLanguage } from '../../contexts/LanguageContext'
import { getTenant } from '../../lib/api/tenants'
import type { Tenant } from '../../types/domain'
import { PageSpinner } from '@/components/atoms'
import { Card, EmptyState } from '@/components/molecules'
import { SettingsCategoryNav, type SettingsCategory } from './settings/SettingsCategoryNav'
import { CompanyProfileSection } from './settings/CompanyProfileSection'
import { StorefrontSection } from './settings/StorefrontSection'
import { PosSettingsSection } from './settings/PosSettingsSection'
import { DocumentsSection } from './settings/DocumentsSection'
import { DispatchStatusesSection } from './settings/DispatchStatusesSection'
import { ReturnsSection } from './settings/ReturnsSection'
import { Warehouses } from './Warehouses'

/** Configuración del tenant -- panel organizado por categorías (pedido
 * explícito del usuario: todo apilado en una sola página larga era
 * inmanejable). Layout de dos columnas: un menú secundario a la izquierda
 * (SettingsCategoryNav, cambia solo qué se muestra a la derecha -- nunca
 * navega ni recarga) y, a la derecha, el panel de la categoría elegida.
 * Cada categoría es su propio componente auto-contenido (título+descripción+
 * acción vía CardSection) -- ver pages/tenant/settings/*.
 *
 * Los permisos y condiciones de visibilidad son exactamente los de antes,
 * solo reorganizados en categorías en vez de secciones apiladas:
 * - Perfil de la empresa / Tienda pública / Punto de venta / Documentos y
 *   tickets: solo tenant_admin (antes vivían dentro de una única
 *   CompanySection admin-only).
 * - Punto de venta / Documentos y tickets, además, solo si el módulo `pos`
 *   está habilitado (antes era el gate de PosSettingsSection/su bloque de
 *   impresión).
 * - Bodegas / Despachos / Devoluciones: cualquier rol, solo si su módulo
 *   respectivo está habilitado (sin cambios).
 */
export function Settings() {
  const { profile, enabledModules } = useAuth()
  const { t } = useLanguage()
  const isAdmin = profile?.role === 'tenant_admin'

  const [tenant, setTenant] = useState<Tenant | null | undefined>(undefined)
  const [tenantError, setTenantError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)

  useEffect(() => {
    if (!isAdmin || !profile?.tenant_id) return
    getTenant(profile.tenant_id)
      .then(setTenant)
      .catch((err) => setTenantError(err.message ?? t('settings.logo.errors.load')))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, profile?.tenant_id])

  // enabledModules === null means AuthContext hasn't loaded the tenant's
  // module flags yet (it fails closed, same convention everywhere else in
  // the app) -- rendering the nav before that would flash an incomplete
  // category list.
  if (enabledModules === null) return <PageSpinner />

  const categories: SettingsCategory[] = [
    isAdmin && { key: 'company', label: t('settings.nav.company'), icon: Building2 },
    isAdmin && { key: 'storefront', label: t('settings.nav.storefront'), icon: Store },
    isAdmin && enabledModules.has('pos') && { key: 'pos', label: t('settings.nav.pos'), icon: ShoppingCart },
    enabledModules.has('inventory') && { key: 'warehouses', label: t('settings.nav.warehouses'), icon: WarehouseIcon },
    enabledModules.has('dispatches') && { key: 'dispatches', label: t('settings.nav.dispatches'), icon: Truck },
    enabledModules.has('returns') && { key: 'returns', label: t('settings.nav.returns'), icon: RotateCcw },
    isAdmin && enabledModules.has('pos') && { key: 'documents', label: t('settings.nav.documents'), icon: FileText },
  ].filter((c): c is SettingsCategory => !!c)

  if (categories.length === 0) {
    return (
      <Card>
        <EmptyState>{t('settings.nav.empty')}</EmptyState>
      </Card>
    )
  }

  const active = categories.some((c) => c.key === selected) ? (selected as string) : categories[0].key

  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
      <SettingsCategoryNav categories={categories} selected={active} onSelect={setSelected} />

      <div className="min-w-0 flex-1">
        {(active === 'company' || active === 'storefront' || active === 'pos' || active === 'documents') && (
          <>
            {tenantError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{tenantError}</p>}
            {!tenantError && tenant === undefined && <PageSpinner />}
            {tenant && active === 'company' && <CompanyProfileSection tenant={tenant} onSaved={setTenant} />}
            {tenant && active === 'storefront' && <StorefrontSection tenant={tenant} onSaved={setTenant} />}
            {tenant && active === 'pos' && <PosSettingsSection tenant={tenant} onSaved={setTenant} />}
            {tenant && active === 'documents' && <DocumentsSection tenant={tenant} onSaved={setTenant} />}
          </>
        )}

        {active === 'warehouses' && <Warehouses />}
        {active === 'dispatches' && profile?.tenant_id && <DispatchStatusesSection tenantId={profile.tenant_id} />}
        {active === 'returns' && profile?.tenant_id && <ReturnsSection tenantId={profile.tenant_id} />}
      </div>
    </div>
  )
}
