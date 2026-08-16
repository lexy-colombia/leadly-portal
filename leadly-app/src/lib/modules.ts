import {
  AiSparkleIcon,
  ArchiveIcon,
  BarChartIcon,
  BoxIcon,
  BuildingIcon,
  CalendarIcon,
  ChatBubbleIcon,
  CheckIcon,
  CreditCardIcon,
  DashboardIcon,
  GlobeIcon,
  MegaphoneIcon,
  ReceiptIcon,
  RefreshIcon,
  SettingsIcon,
  TargetIcon,
  UsersIcon,
} from '../components/icons'
import type { TranslationKey } from '../i18n/translations'
import type { ComponentType } from 'react'

/** The fixed catalog of tenant-panel nav items, keyed the same way the DB's
 * tenant_enabled_modules.module_key check constraint expects (keep both in
 * sync -- this file is the single source of truth for label/icon/route,
 * the DB constraint is only there as a data-integrity backstop). Every item
 * here is toggleable per tenant (2026-08-11, explicit superadmin decision:
 * even Dashboard/Conversaciones/Configuración can be turned off) -- used to
 * gate each /app route via RequireModule, render the "Módulos" tab in the
 * backoffice's ClienteDetalle, AND build TenantLayout's nav (grouped via
 * CRM_GROUP_KEYS below, not a flat list anymore -- see TenantLayout.tsx). */
export interface TenantModuleDefinition {
  key: string
  labelKey: TranslationKey
  to: string
  icon: ComponentType<{ width?: number; height?: number }>
  badge?: TranslationKey
  /** True for a module whose UI moved somewhere other than its own nav
   * slot (2026-08-16: Bodegas moved into "Configuración" -> perfil de la
   * empresa) -- it keeps its module_key/gating/backoffice toggle, it just
   * doesn't get a sidebar item of its own anymore. */
  hideFromNav?: boolean
}

export const TENANT_MODULES: TenantModuleDefinition[] = [
  { key: 'dashboard', labelKey: 'common.nav.dashboard', to: '/app/dashboard', icon: DashboardIcon },
  { key: 'conversations', labelKey: 'common.nav.conversations', to: '/app', icon: ChatBubbleIcon },
  { key: 'contacts', labelKey: 'common.nav.contacts', to: '/app/clientes', icon: BuildingIcon },
  { key: 'pipeline', labelKey: 'common.nav.pipeline', to: '/app/oportunidades', icon: TargetIcon },
  { key: 'products', labelKey: 'common.nav.products', to: '/app/productos', icon: BoxIcon },
  { key: 'inventory', labelKey: 'common.nav.inventory', to: '/app/configuracion', icon: ArchiveIcon, hideFromNav: true },
  { key: 'sales', labelKey: 'common.nav.sales', to: '/app/ventas', icon: ReceiptIcon },
  { key: 'tasks', labelKey: 'common.nav.tasks', to: '/app/tareas', icon: CheckIcon },
  { key: 'calendar', labelKey: 'common.nav.calendar', to: '/app/calendario', icon: CalendarIcon },
  { key: 'campaigns', labelKey: 'common.nav.campaigns', to: '/app/campanas', icon: MegaphoneIcon, badge: 'common.badge.beta' },
  { key: 'reports', labelKey: 'common.nav.reports', to: '/app/reportes', icon: BarChartIcon },
  { key: 'automations', labelKey: 'common.nav.automations', to: '/app/automatizaciones', icon: RefreshIcon },
  { key: 'aiAgents', labelKey: 'common.nav.aiAgents', to: '/app/ia-agentes', icon: AiSparkleIcon },
  { key: 'billing', labelKey: 'common.nav.billing', to: '/app/facturacion', icon: CreditCardIcon },
  { key: 'integrations', labelKey: 'common.nav.integrations', to: '/app/integraciones', icon: GlobeIcon },
  { key: 'settings', labelKey: 'common.nav.settings', to: '/app/configuracion', icon: SettingsIcon },
]

export type TenantModuleKey = (typeof TENANT_MODULES)[number]['key']

/** Modules grouped under a single "CRM" nav entry (conversaciones, clientes,
 * pipeline, tareas, campañas, agentes de IA) -- the lead/customer-facing
 * side of the app, as opposed to the ERP operations modules (productos,
 * ventas, calendario, reportes, facturación...) that stay top-level.
 * Declutters the sidebar (2026-08-16, explicit user request) without
 * changing gating: each module here still has its own module_key/route
 * guard, this only changes how TenantLayout groups them visually. */
export const CRM_GROUP_KEY = 'crm'
export const CRM_GROUP_ICON = UsersIcon
export const CRM_GROUP_MODULE_KEYS: TenantModuleKey[] = ['conversations', 'contacts', 'pipeline', 'tasks', 'campaigns', 'aiAgents']
