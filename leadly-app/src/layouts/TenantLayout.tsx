import { useAuth } from '../contexts/AuthContext'
import { useLanguage } from '../contexts/LanguageContext'
import { AppShell, type NavItem } from '@/components/organisms'
import { CRM_GROUP_ICON, TENANT_MODULES } from '../lib/modules'

import { groupTenantModules } from '../lib/moduleHierarchy'

export function TenantLayout() {
  const { t } = useLanguage()
  const { enabledModules, permissions, profile } = useAuth()

  const enabled = TENANT_MODULES.filter((module) => {
    if (module.adminOnly && profile?.role !== 'tenant_admin') return false
    if (module.viewAction && !permissions?.has(module.viewAction)) return false
    const moduleEnabled = module.alwaysEnabled || enabledModules?.has(module.key)
    return moduleEnabled && !module.hideFromNav
  })
  const navItems: NavItem[] = groupTenantModules(enabled).map((node) => {
    const definition = TENANT_MODULES.find((module) => module.key === node.key)
    const children: NavItem[] = []
    if (node.module?.subRoutes?.length) {
      children.push(
        { to: node.module.to, label: t(node.module.labelKey), icon: node.module.icon },
        ...node.module.subRoutes.map((sub) => ({ to: sub.to, label: t(sub.labelKey), icon: node.module!.icon })),
      )
    }
    children.push(...node.children.flatMap((child) => child.module ? [{
      to: child.module.to,
      label: t(child.module.labelKey),
      icon: child.module.icon,
      badge: child.module.badge ? t(child.module.badge) : undefined,
    }] : []))
    return {
      to: node.module?.to ?? children[0].to,
      label: node.key === 'crm' ? t('common.nav.crm') : t(definition!.labelKey),
      icon: definition?.icon ?? CRM_GROUP_ICON,
      badge: node.module?.badge ? t(node.module.badge) : undefined,
      children: children.length ? children : undefined,
    }
  })

  return <AppShell subtitle={t('common.shell.tenantSubtitle')} navItems={navItems} theme="dark" />
}
