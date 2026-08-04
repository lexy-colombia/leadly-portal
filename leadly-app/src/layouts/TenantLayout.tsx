import { AppShell, type NavItem } from '../components/layout/AppShell'
import { useAuth } from '../contexts/AuthContext'
import { AiSparkleIcon, BellIcon, BuildingIcon, CatalogIcon, ChatBubbleIcon, MegaphoneIcon, UsersIcon } from '../components/icons'

const BASE_NAV_ITEMS: NavItem[] = [
  { to: '/app', label: 'Conversaciones', icon: ChatBubbleIcon },
  { to: '/app/clientes', label: 'Clientes', icon: BuildingIcon },
  { to: '/app/campanas', label: 'Campañas', icon: MegaphoneIcon, badge: 'Beta' },
  { to: '/app/catalogo', label: 'Catálogo', icon: CatalogIcon, badge: 'Beta' },
  { to: '/app/asistente', label: 'Asistente de IA', icon: AiSparkleIcon },
  { to: '/app/novedades', label: 'Novedades', icon: BellIcon },
]

const ADMIN_NAV_ITEMS: NavItem[] = [{ to: '/app/usuarios', label: 'Usuarios', icon: UsersIcon }]

export function TenantLayout() {
  const { profile } = useAuth()
  const navItems = profile?.role === 'tenant_admin' ? [...BASE_NAV_ITEMS, ...ADMIN_NAV_ITEMS] : BASE_NAV_ITEMS

  return <AppShell subtitle="Panel del cliente · Leadly" navItems={navItems} theme="light" />
}
