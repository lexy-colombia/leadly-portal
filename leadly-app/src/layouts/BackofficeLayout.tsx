import { AppShell, type NavItem } from '../components/layout/AppShell'
import { BuildingIcon, CreditCardIcon, DashboardIcon, KeyIcon } from '../components/icons'

// Líneas de WhatsApp deliberately has no top-level nav entry -- it lives inside
// each Cliente's detail page (a line always belongs to exactly one tenant).
const NAV_ITEMS: NavItem[] = [
  { to: '/backoffice', label: 'Dashboard', icon: DashboardIcon },
  { to: '/backoffice/clientes', label: 'Clientes', icon: BuildingIcon },
  { to: '/backoffice/facturacion', label: 'Facturación', icon: CreditCardIcon },
  { to: '/backoffice/configuracion', label: 'Configuración de IA', icon: KeyIcon },
]

export function BackofficeLayout() {
  return <AppShell subtitle="Backoffice · Leadly" navItems={NAV_ITEMS} />
}
