import { AiSparkleIcon, ArchiveIcon, BoxIcon, BuildingIcon, CalendarIcon, ChatBubbleIcon, CheckIcon, CreditCardIcon, DashboardIcon, GlobeIcon, MegaphoneIcon, ReceiptIcon, RefreshIcon, SettingsIcon, TargetIcon, UsersIcon, WalletIcon } from '@/components/atoms/icons'
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
  { key: 'contacts', labelKey: 'common.nav.contacts', to: '/app/clients', icon: BuildingIcon },
  { key: 'pipeline', labelKey: 'common.nav.pipeline', to: '/app/opportunities', icon: TargetIcon },
  {
    key: 'products',
    labelKey: 'common.nav.products',
    to: '/app/products',
    icon: BoxIcon,
    subRoutes: [
      { labelKey: 'common.nav.productCategories', to: '/app/products/categories' },
      { labelKey: 'common.nav.brands', to: '/app/products/brands' },
      { labelKey: 'common.nav.suppliers', to: '/app/products/suppliers' },
    ],
  },
  { key: 'inventory', labelKey: 'common.nav.inventory', to: '/app/settings', icon: ArchiveIcon, hideFromNav: true },
  { key: 'sales', labelKey: 'common.nav.sales', to: '/app/sales', icon: ReceiptIcon },
  { key: 'credit', labelKey: 'common.nav.credit', to: '/app/credit', icon: WalletIcon },
  // Igual que 'inventory': vive dentro de una orden (DispatchDrawer, "Ver
  // detalle" junto a Estado de envío) y dentro de Configuración
  // (DispatchStatusesSection) -- sin ítem de nav propio.
  { key: 'dispatches', labelKey: 'common.nav.dispatches', to: '/app/settings', icon: BoxIcon, hideFromNav: true },
  // A diferencia de credit/dispatches, Devoluciones sí tiene nav propio --
  // es una lista de tickets propia (Returns.tsx), no vive adentro de otra
  // pantalla.
  { key: 'returns', labelKey: 'common.nav.returns', to: '/app/returns', icon: RefreshIcon },
  // Tareas se fusionó dentro de Calendario (2026-08-19, pedido explícito del
  // usuario: "el calendario debería ser la matriz de mi CRM") -- mismo
  // patrón que 'inventory': el module_key/gating por tenant se conserva
  // (OpportunityPanel/ClientDetail siguen usando datos de tasks en sus tabs
  // propias), pero ya no tiene ítem de nav propio y su ruta apunta al
  // calendario, que solo renderiza la capa de tareas si este módulo sigue
  // habilitado para el tenant (ver Calendar.tsx, enabledModules.has('tasks')).
  { key: 'tasks', labelKey: 'common.nav.tasks', to: '/app/calendar', icon: CheckIcon, hideFromNav: true },
  { key: 'calendar', labelKey: 'common.nav.calendar', to: '/app/calendar', icon: CalendarIcon },
  { key: 'campaigns', labelKey: 'common.nav.campaigns', to: '/app/campaigns', icon: MegaphoneIcon },
  { key: 'aiAgents', labelKey: 'common.nav.aiAgents', to: '/app/ai-agents', icon: AiSparkleIcon },
  { key: 'billing', labelKey: 'common.nav.billing', to: '/app/billing', icon: CreditCardIcon },
  { key: 'integrations', labelKey: 'common.nav.integrations', to: '/app/integrations', icon: GlobeIcon },
  { key: 'settings', labelKey: 'common.nav.settings', to: '/app/settings', icon: SettingsIcon },
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
