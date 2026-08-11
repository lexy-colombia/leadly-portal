import {
  AiSparkleIcon,
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
} from '../components/icons'
import type { TranslationKey } from '../i18n/translations'
import type { ComponentType } from 'react'

/** The fixed catalog of tenant-panel nav items, keyed the same way the DB's
 * tenant_enabled_modules.module_key check constraint expects (keep both in
 * sync -- this file is the single source of truth for label/icon/route,
 * the DB constraint is only there as a data-integrity backstop). Every item
 * here is toggleable per tenant (2026-08-11, explicit superadmin decision:
 * even Dashboard/Conversaciones/Configuración can be turned off) -- used to
 * build TenantLayout's nav, gate each /app route via RequireModule, and
 * render the "Módulos" tab in the backoffice's ClienteDetalle. */
export interface TenantModuleDefinition {
  key: string
  labelKey: TranslationKey
  to: string
  icon: ComponentType<{ width?: number; height?: number }>
  badge?: TranslationKey
}

export const TENANT_MODULES: TenantModuleDefinition[] = [
  { key: 'dashboard', labelKey: 'common.nav.dashboard', to: '/app/dashboard', icon: DashboardIcon },
  { key: 'conversations', labelKey: 'common.nav.conversations', to: '/app', icon: ChatBubbleIcon },
  { key: 'contacts', labelKey: 'common.nav.contacts', to: '/app/clientes', icon: BuildingIcon },
  { key: 'pipeline', labelKey: 'common.nav.pipeline', to: '/app/oportunidades', icon: TargetIcon },
  { key: 'products', labelKey: 'common.nav.products', to: '/app/productos', icon: BoxIcon },
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
