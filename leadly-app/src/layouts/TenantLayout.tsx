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

const NAV_ITEMS: NavItem[] = [
  { to: '/app/dashboard', label: 'Dashboard', icon: DashboardIcon },
  { to: '/app', label: 'Conversaciones', icon: ChatBubbleIcon },
  { to: '/app/clientes', label: 'Contactos', icon: BuildingIcon },
  { to: '/app/oportunidades', label: 'Pipeline', icon: TargetIcon },
  { to: '/app/productos', label: 'Productos', icon: BoxIcon },
  { to: '/app/ventas', label: 'Cotizaciones y Ventas', icon: ReceiptIcon },
  { to: '/app/tareas', label: 'Tareas', icon: CheckIcon },
  { to: '/app/calendario', label: 'Calendario', icon: CalendarIcon },
  { to: '/app/campanas', label: 'Campañas', icon: MegaphoneIcon, badge: 'Beta' },
  { to: '/app/reportes', label: 'Reportes', icon: BarChartIcon },
  { to: '/app/automatizaciones', label: 'Automatizaciones', icon: RefreshIcon },
  { to: '/app/ia-agentes', label: 'IA & Agentes', icon: AiSparkleIcon },
  { to: '/app/facturacion', label: 'Facturación', icon: CreditCardIcon },
  { to: '/app/configuracion', label: 'Configuración', icon: SettingsIcon },
]

export function TenantLayout() {
  return <AppShell subtitle="Panel del cliente · Leadly" navItems={NAV_ITEMS} theme="light" showUpsell />
}
