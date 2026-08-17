import { useLanguage } from '../contexts/LanguageContext'
import { AppShell, type NavItem } from '@/components/organisms'
import { BuildingIcon, CreditCardIcon, DashboardIcon, GlobeIcon, KeyIcon } from '@/components/atoms/icons'
// Líneas de WhatsApp deliberately has no top-level nav entry -- it lives inside
// each Cliente's detail page (a line always belongs to exactly one tenant).
export function BackofficeLayout() {
  const { t } = useLanguage()

  const navItems: NavItem[] = [
    { to: '/backoffice', label: t('common.nav.dashboard'), icon: DashboardIcon },
    { to: '/backoffice/clientes', label: t('common.nav.clients'), icon: BuildingIcon },
    { to: '/backoffice/facturacion', label: t('common.nav.billing'), icon: CreditCardIcon },
    { to: '/backoffice/integraciones', label: t('common.nav.integrations'), icon: GlobeIcon },
    { to: '/backoffice/configuracion', label: t('common.nav.aiSettings'), icon: KeyIcon },
  ]

  return <AppShell subtitle={t('common.shell.backofficeSubtitle')} navItems={navItems} />
}
