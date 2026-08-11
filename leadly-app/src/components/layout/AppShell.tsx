import { useEffect, useMemo, useState, type ComponentType, type ReactNode } from 'react'
import { Link, Outlet, useLocation } from 'react-router-dom'
import changelogRaw from '../../../CHANGELOG.md?raw'
import { useAuth } from '../../contexts/AuthContext'
import { SidebarNavItem } from './SidebarNavItem'
import { NotificationsBell } from './NotificationsBell'
import { LanguageSwitcher } from './LanguageSwitcher'
import { Button, InitialsAvatar } from '../ui'
import { Logo } from '../brand/Logo'
import { ChevronLeftIcon, LogoutIcon, MenuIcon } from '../icons'

// "Novedades" used to be its own nav entry -- moved here as a quiet version
// link under "Cerrar sesión" instead, since it's a "check when curious" page,
// not something that needs a permanent slot in the primary nav. Pulls the
// topmost `## ` heading straight from CHANGELOG.md (e.g. "[0.1.0]" -> "0.1.0",
// or "[Unreleased]" as-is) so this never drifts out of sync with the page it
// links to.
const CURRENT_VERSION = (() => {
  const match = changelogRaw.match(/^## \[?([^\]\n]+)\]?/m)
  return match ? match[1].trim() : ''
})()

export interface NavItem {
  to: string
  label: string
  icon: ComponentType<{ width?: number; height?: number }>
  /** Small pill after the label, e.g. "BETA" for features that are visible
   * but intentionally locked (Campañas, Catálogo) -- signals "coming soon",
   * not a permissions error. */
  badge?: string
}

const COLLAPSE_STORAGE_KEY = 'leadly:sidebar-collapsed'

// Every page used to render its own "<h1>Title</h1><p>description</p>" block,
// which duplicated the nav label right below it and added a lot of repeated
// boilerplate across every page. Pages no longer render a title at all --
// this derives it from whichever nav item's route path is the longest match
// for the current URL (so a detail route like /app/clientes/:id still shows
// "Clientes", the nav item it lives under), with the two routes that aren't
// in the nav (perfil, novedades) special-cased since they're shared between
// both layouts. When the match is a nested route (a "detail" page one level
// below its list, e.g. /app/clientes/:id under /app/clientes), `backTo` is
// set so the header renders a clickable "← Clientes" instead of a plain
// title -- pages no longer need their own "Volver a ..." link in the body.
function resolvePageTitle(pathname: string, navItems: NavItem[]): { title: string; badge?: string; backTo?: string } {
  if (pathname.endsWith('/perfil')) return { title: 'Mi cuenta' }
  if (pathname.endsWith('/novedades')) return { title: 'Novedades' }

  const matches = navItems.filter((item) => pathname === item.to || pathname.startsWith(`${item.to}/`))
  const best = matches.reduce<NavItem | null>((longest, item) => (!longest || item.to.length > longest.to.length ? item : longest), null)
  if (!best) return { title: '' }
  return { title: best.label, badge: best.badge, backTo: pathname !== best.to ? best.to : undefined }
}

/** Shared responsive shell for both BackofficeLayout and TenantLayout: a
 * desktop sidebar that can collapse to icon-only (persisted across reloads)
 * and slides into an off-canvas drawer on mobile. Content area is fluid
 * (no max-width) so it uses all the space next to the sidebar.
 *
 * `theme` flips the sidebar between the original dark-navy chrome
 * (backoffice) and a light/white one (tenant panel, matching a reference
 * design the user asked to adopt for their own client-facing side first,
 * 2026-08-04) -- the accent pill on the active nav item stays Leadly's
 * turquoise in both, only the surrounding chrome changes. */
export function AppShell({
  subtitle,
  navItems,
  theme = 'dark',
  showUpsell = false,
}: {
  subtitle: string
  navItems: NavItem[]
  theme?: 'dark' | 'light'
  /** Shows the "Prueba Leadly Pro" upgrade card above the profile footer --
   * only meaningful for the tenant panel, superadmins have nothing to upgrade. */
  showUpsell?: boolean
}) {
  const { profile, signOut } = useAuth()
  const location = useLocation()
  const basePath = location.pathname.startsWith('/backoffice') ? '/backoffice' : '/app'
  const profilePath = `${basePath}/perfil`
  const changelogPath = `${basePath}/novedades`
  const pageHeader = useMemo(() => resolvePageTitle(location.pathname, navItems), [location.pathname, navItems])
  const [mobileOpen, setMobileOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSE_STORAGE_KEY) === '1')
  const isLight = theme === 'light'

  useEffect(() => {
    localStorage.setItem(COLLAPSE_STORAGE_KEY, collapsed ? '1' : '0')
  }, [collapsed])

  return (
    <div className="flex h-screen overflow-hidden bg-[var(--color-surface)]">
      <div
        className={`fixed inset-x-0 top-0 z-40 flex h-14 items-center justify-between border-b px-4 lg:hidden ${
          isLight ? 'border-brand-100 bg-white' : 'border-brand-800 bg-brand-700'
        }`}
      >
        <Logo size="sm" onDark={!isLight} />
        <button
          type="button"
          onClick={() => setMobileOpen(true)}
          aria-label="Abrir menú"
          className={isLight ? '-mr-2 p-2 text-brand-500 hover:text-brand-800' : '-mr-2 p-2 text-brand-100 hover:text-white'}
        >
          <MenuIcon />
        </button>
      </div>

      {mobileOpen && (
        <div
          className="animate-fade-in fixed inset-0 z-40 bg-brand-900/40 lg:hidden"
          onClick={() => setMobileOpen(false)}
          aria-hidden="true"
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-50 flex shrink-0 flex-col transition-[width,transform] duration-200 lg:static lg:translate-x-0 ${
          isLight ? 'border-r border-brand-100 bg-white text-brand-700' : 'bg-brand-700 text-brand-100'
        } ${mobileOpen ? 'translate-x-0' : '-translate-x-full'} ${collapsed ? 'lg:w-20' : 'lg:w-64'} w-64`}
      >
        <div
          className={`flex items-center gap-2 border-b px-4 py-3.5 ${isLight ? 'border-brand-100' : 'border-brand-800'} ${collapsed ? 'lg:justify-center lg:px-0' : ''}`}
        >
          <div className={collapsed ? 'lg:hidden' : ''}>
            <Logo size="sm" onDark={!isLight} />
          </div>
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            aria-label={collapsed ? 'Expandir menú' : 'Colapsar menú'}
            className={`hidden rounded-lg p-1.5 lg:ml-auto lg:block ${
              isLight ? 'text-brand-400 hover:bg-brand-50 hover:text-brand-800' : 'text-brand-300 hover:bg-brand-600 hover:text-white'
            }`}
          >
            <ChevronLeftIcon className={`transition-transform duration-200 ${collapsed ? 'rotate-180' : ''}`} />
          </button>
        </div>

        <p className={`px-4 pb-2 pt-3 text-[11px] leading-tight ${isLight ? 'text-brand-300' : 'text-brand-300'} ${collapsed ? 'lg:hidden' : ''}`}>
          {subtitle}
        </p>

        <nav className="flex-1 space-y-0.5 overflow-y-auto px-2.5 py-2">
          {navItems.map((item, i) => (
            <div key={item.to} className="animate-sidebar-item-in" style={{ animationDelay: `${i * 30}ms` }}>
              <SidebarNavItem
                to={item.to}
                label={item.label}
                icon={item.icon}
                badge={item.badge}
                collapsed={collapsed}
                theme={theme}
                onClick={() => setMobileOpen(false)}
              />
            </div>
          ))}
        </nav>

        {showUpsell && (
          <div className={`px-2.5 pb-1 ${collapsed ? 'lg:hidden' : ''}`}>
            <div className="rounded-xl bg-brand-50 p-3">
              <p className="text-xs font-semibold text-brand-800">Prueba Leadly Pro</p>
              <p className="mt-0.5 text-[11px] leading-snug text-brand-400">Desbloquea más funciones para hacer crecer tu negocio.</p>
              <Button variant="primary" className="mt-2 w-full !py-1.5 text-xs">
                Actualizar plan
              </Button>
            </div>
          </div>
        )}

        <div className={`border-t px-2.5 py-2.5 ${isLight ? 'border-brand-100' : 'border-brand-800'} ${collapsed ? 'lg:px-2' : ''}`}>
          <Link
            to={profilePath}
            title={collapsed ? profile?.full_name : undefined}
            onClick={() => setMobileOpen(false)}
            className={`flex items-center gap-2 rounded-lg px-1.5 py-1 ${collapsed ? 'lg:justify-center lg:px-0' : ''} ${
              isLight ? 'hover:bg-brand-50' : 'hover:bg-white/5'
            }`}
          >
            <InitialsAvatar name={profile?.full_name ?? '?'} size="sm" />
            <span className={`min-w-0 flex-1 ${collapsed ? 'lg:hidden' : ''}`}>
              <span className={`block truncate text-xs font-semibold ${isLight ? 'text-brand-800' : 'text-white'}`}>{profile?.full_name}</span>
              <span className={`block truncate text-[11px] ${isLight ? 'text-brand-400' : 'text-brand-300'}`}>{profile?.email}</span>
            </span>
          </Link>
          <Button
            variant={isLight ? 'ghost' : 'ghost-dark'}
            onClick={() => signOut()}
            title={collapsed ? 'Cerrar sesión' : undefined}
            className={`mt-1.5 w-full !py-1.5 text-xs ${collapsed ? 'lg:justify-center lg:px-0' : 'justify-start'}`}
          >
            <LogoutIcon width={13} height={13} />
            <span className={collapsed ? 'lg:hidden' : ''}>Cerrar sesión</span>
          </Button>
          {CURRENT_VERSION && (
            <Link
              to={changelogPath}
              onClick={() => setMobileOpen(false)}
              title={collapsed ? `Versión ${CURRENT_VERSION} · Novedades` : undefined}
              className={`mt-1.5 block truncate text-center text-[10px] ${collapsed ? 'lg:hidden' : ''} ${
                isLight ? 'text-brand-300 hover:text-brand-600' : 'text-brand-400 hover:text-brand-200'
              }`}
            >
              v{CURRENT_VERSION} · Novedades
            </Link>
          )}
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden pt-14 lg:pt-0">
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-brand-100 bg-white px-5 py-2.5 lg:px-8">
          <div className="flex min-w-0 items-center gap-2">
            {pageHeader.backTo ? (
              <Link
                to={pageHeader.backTo}
                className="flex min-w-0 items-center gap-1 truncate text-base font-semibold text-brand-800 transition-colors hover:text-accent-700 sm:text-lg"
              >
                <ChevronLeftIcon width={18} height={18} className="shrink-0" />
                <span className="truncate">{pageHeader.title}</span>
              </Link>
            ) : (
              <h1 className="truncate text-base font-semibold text-brand-800 sm:text-lg">{pageHeader.title}</h1>
            )}
            {pageHeader.badge && (
              <span className="shrink-0 rounded-full bg-amber-100 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-amber-700">
                {pageHeader.badge}
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <LanguageSwitcher />
            <NotificationsBell theme="light" />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-5 lg:p-8">
          <PageOutlet />
        </div>
      </main>
    </div>
  )
}

function PageOutlet(): ReactNode {
  return <Outlet />
}
