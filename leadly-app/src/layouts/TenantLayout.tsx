import { useLanguage } from '../contexts/LanguageContext'
import { AppShell, type NavItem } from '../components/layout/AppShell'
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
  MegaphoneIcon,
  ReceiptIcon,
  RefreshIcon,
  SettingsIcon,
  TargetIcon,
} from '../components/icons'

export function TenantLayout() {
  const { t } = useLanguage()

  const navItems: NavItem[] = [
    { to: '/app/dashboard', label: t('common.nav.dashboard'), icon: DashboardIcon },
    { to: '/app', label: t('common.nav.conversations'), icon: ChatBubbleIcon },
    { to: '/app/clientes', label: t('common.nav.contacts'), icon: BuildingIcon },
    { to: '/app/oportunidades', label: t('common.nav.pipeline'), icon: TargetIcon },
    { to: '/app/productos', label: t('common.nav.products'), icon: BoxIcon },
    { to: '/app/ventas', label: t('common.nav.sales'), icon: ReceiptIcon },
    { to: '/app/tareas', label: t('common.nav.tasks'), icon: CheckIcon },
    { to: '/app/calendario', label: t('common.nav.calendar'), icon: CalendarIcon },
    { to: '/app/campanas', label: t('common.nav.campaigns'), icon: MegaphoneIcon, badge: t('common.badge.beta') },
    { to: '/app/reportes', label: t('common.nav.reports'), icon: BarChartIcon },
    { to: '/app/automatizaciones', label: t('common.nav.automations'), icon: RefreshIcon },
    { to: '/app/ia-agentes', label: t('common.nav.aiAgents'), icon: AiSparkleIcon },
    { to: '/app/facturacion', label: t('common.nav.billing'), icon: CreditCardIcon },
    { to: '/app/configuracion', label: t('common.nav.settings'), icon: SettingsIcon },
  ]

  return <AppShell subtitle={t('common.shell.tenantSubtitle')} navItems={navItems} theme="light" showUpsell />
}
