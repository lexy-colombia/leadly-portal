import { AiSparkleIcon, ArchiveIcon, BoxIcon, BuildingIcon, CalendarIcon, ChatBubbleIcon, CheckIcon, CreditCardIcon, DashboardIcon, GlobeIcon, MegaphoneIcon, ReceiptIcon, SettingsIcon, TargetIcon, UsersIcon } from '@/components/atoms/icons'
import type { TranslationKey } from '../i18n/translations'
import type { ComponentType } from 'react'

/** The fixed catalog of tenant-panel nav items, keyed the same way the DB's
 * tenant_enabled_modules.module_key check constraint expects (keep both in
 * sync -- this file is the single source of truth for label/icon/route,
 * the DB constraint is only there as a data-integrity backstop). Every item
 * here is toggleable per tenant (2026-08-11, explicit superadmin decision:
 * even Dashboard/Conversaciones/Configuración can be turned off) -- used to
 * gate each /app route via RequireModule, render the "Módulos" tab in the
 * backoffice's TenantDetail, AND build TenantLayout's nav (grouped via
 * CRM_GROUP_KEYS below, not a flat list anymore -- see TenantLayout.tsx). */
export interface TenantModuleDefinition {
  key: string
  labelKey: TranslationKey
  to: string
  icon: ComponentType<{ width?: number; height?: number }>
  badge?: TranslationKey
  /** True for a module whose UI moved somewhere other than its own nav
   * slot (2026-08-16: Warehouses moved into "Configuración" -> perfil de la
   * empresa) -- it keeps its module_key/gating/backoffice toggle, it just
   * doesn't get a sidebar item of its own anymore. */
  hideFromNav?: boolean
  /** Static sub-pages that always travel with this module (no separate
   * module_key/gating of their own -- e.g. Categorías/Brands only make
   * sense when "products" itself is enabled). Different from
   * CRM_GROUP_MODULE_KEYS below, which groups several independently-gated
   * top-level modules -- this is one module with an intrinsic sub-nav. */
  subRoutes?: { labelKey: TranslationKey; to: string }[]
}

export const TENANT_MODULES: TenantModuleDefinition[] = [
  { key: 'dashboard', labelKey: 'common.nav.dashboard', to: '/app/dashboard', icon: DashboardIcon },
  { key: 'conversations', labelKey: 'common.nav.conversations', to: '/app', icon: ChatBubbleIcon },
  { key: 'contacts', labelKey: 'common.nav.contacts', to: '/app/clientes', icon: BuildingIcon },
  { key: 'pipeline', labelKey: 'common.nav.pipeline', to: '/app/oportunidades', icon: TargetIcon },
  {
    key: 'products',
    labelKey: 'common.nav.products',
    to: '/app/productos',
    icon: BoxIcon,
    subRoutes: [
      { labelKey: 'common.nav.productCategories', to: '/app/productos/categorias' },
      { labelKey: 'common.nav.brands', to: '/app/productos/marcas' },
    ],
  },
  { key: 'inventory', labelKey: 'common.nav.inventory', to: '/app/configuracion', icon: ArchiveIcon, hideFromNav: true },
  { key: 'sales', labelKey: 'common.nav.sales', to: '/app/ventas', icon: ReceiptIcon },
  { key: 'tasks', labelKey: 'common.nav.tasks', to: '/app/tareas', icon: CheckIcon },
  { key: 'calendar', labelKey: 'common.nav.calendar', to: '/app/calendario', icon: CalendarIcon },
  { key: 'campaigns', labelKey: 'common.nav.campaigns', to: '/app/campanas', icon: MegaphoneIcon, badge: 'common.badge.beta' },
  { key: 'aiAgents', labelKey: 'common.nav.aiAgents', to: '/app/ia-agentes', icon: AiSparkleIcon },
  { key: 'billing', labelKey: 'common.nav.billing', to: '/app/facturacion', icon: CreditCardIcon },
  { key: 'integrations', labelKey: 'common.nav.integrations', to: '/app/integraciones', icon: GlobeIcon },
  { key: 'settings', labelKey: 'common.nav.settings', to: '/app/configuracion', icon: SettingsIcon },
]

export type TenantModuleKey = (typeof TENANT_MODULES)[number]['key']

/** Modules grouped under a single "CRM" nav entry (conversaciones, pipeline,
 * tareas, calendario, campañas, agentes de IA) -- the lead/customer-facing
 * side of the app, as opposed to the ERP operations modules (productos,
 * ventas, facturación...) that stay top-level. Clientes is deliberately NOT
 * in this group (2026-08-17, explicit user request) -- stays a standalone
 * top-level nav item, not tucked under "CRM". Declutters the sidebar
 * (2026-08-16, explicit user request) without changing gating: each module
 * here still has its own module_key/route guard, this only changes how
 * TenantLayout groups them visually. */
export const CRM_GROUP_KEY = 'crm'
export const CRM_GROUP_ICON = UsersIcon
export const CRM_GROUP_MODULE_KEYS: TenantModuleKey[] = ['conversations', 'pipeline', 'tasks', 'calendar', 'campaigns', 'aiAgents']
