import { useAuth } from '../contexts/AuthContext'
import { useLanguage } from '../contexts/LanguageContext'
import { AppShell, type NavItem } from '../components/layout/AppShell'
import { TENANT_MODULES } from '../lib/modules'

export function TenantLayout() {
  const { t } = useLanguage()
  const { enabledModules } = useAuth()

  const navItems: NavItem[] = TENANT_MODULES.filter((module) => enabledModules?.has(module.key)).map((module) => ({
    to: module.to,
    label: t(module.labelKey),
    icon: module.icon,
    badge: module.badge ? t(module.badge) : undefined,
  }))

  return <AppShell subtitle={t('common.shell.tenantSubtitle')} navItems={navItems} theme="light" />
}
