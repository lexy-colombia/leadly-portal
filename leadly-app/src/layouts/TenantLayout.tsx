import { useAuth } from '../contexts/AuthContext'
import { useLanguage } from '../contexts/LanguageContext'
import { AppShell, type NavItem } from '@/components/organisms'
import { CRM_GROUP_ICON, CRM_GROUP_MODULE_KEYS, TENANT_MODULES } from '../lib/modules'

export function TenantLayout() {
  const { t } = useLanguage()
  const { enabledModules } = useAuth()

  const enabled = TENANT_MODULES.filter((module) => enabledModules?.has(module.key) && !module.hideFromNav)
  const crmChildren: NavItem[] = enabled
    .filter((module) => CRM_GROUP_MODULE_KEYS.includes(module.key))
    .map((module) => ({ to: module.to, label: t(module.labelKey), icon: module.icon, badge: module.badge ? t(module.badge) : undefined }))
  const rest = enabled.filter((module) => !CRM_GROUP_MODULE_KEYS.includes(module.key))

  const navItems: NavItem[] = []
  for (const module of rest) {
    if (module.subRoutes && module.subRoutes.length > 0) {
      // A module with intrinsic sub-pages (e.g. Products -> Categorías/
      // Brands, 2026-08-16): the module itself is the first child so it's
      // still one click away, not just a toggle -- same convention as the
      // CRM group's first child substituting for the parent link.
      const children: NavItem[] = [
        { to: module.to, label: t(module.labelKey), icon: module.icon },
        ...module.subRoutes.map((sub) => ({ to: sub.to, label: t(sub.labelKey), icon: module.icon })),
      ]
      navItems.push({ to: module.to, label: t(module.labelKey), icon: module.icon, badge: module.badge ? t(module.badge) : undefined, children })
    } else {
      navItems.push({ to: module.to, label: t(module.labelKey), icon: module.icon, badge: module.badge ? t(module.badge) : undefined })
    }
    // CRM group sits right after Dashboard -- fixed position, not wherever
    // its first member happened to fall in TENANT_MODULES' original order.
    if (module.key === 'dashboard' && crmChildren.length > 0) {
      navItems.push({ to: crmChildren[0].to, label: t('common.nav.crm'), icon: CRM_GROUP_ICON, children: crmChildren })
    }
  }
  // Dashboard itself can be disabled per tenant -- if it is, the group still
  // needs to render, just first instead of second.
  if (crmChildren.length > 0 && !navItems.some((item) => item.children)) {
    navItems.unshift({ to: crmChildren[0].to, label: t('common.nav.crm'), icon: CRM_GROUP_ICON, children: crmChildren })
  }

  return <AppShell subtitle={t('common.shell.tenantSubtitle')} navItems={navItems} theme="light" />
}
