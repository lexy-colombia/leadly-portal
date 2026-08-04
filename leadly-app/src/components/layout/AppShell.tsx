import { useEffect, useState, type ComponentType, type ReactNode } from 'react'
import { Link, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { SidebarNavItem } from './SidebarNavItem'
import { NotificationsBell } from './NotificationsBell'
import { LanguageSwitcher } from './LanguageSwitcher'
import { Button, InitialsAvatar } from '../ui'
import { Logo } from '../brand/Logo'
import { ChevronLeftIcon, LogoutIcon, MenuIcon } from '../icons'

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
export function AppShell({ subtitle, navItems, theme = 'dark' }: { subtitle: string; navItems: NavItem[]; theme?: 'dark' | 'light' }) {
  const { profile, signOut } = useAuth()
  const location = useLocation()
  const profilePath = `${location.pathname.startsWith('/backoffice') ? '/backoffice' : '/app'}/perfil`
  const [mobileOpen, setMobileOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSE_STORAGE_KEY) === '1')
  const isLight = theme === 'light'

  useEffect(() => {
    localStorage.setItem(COLLAPSE_STORAGE_KEY, collapsed ? '1' : '0')
  }, [collapsed])

  return (
    <div className="flex min-h-screen bg-[var(--color-surface)]">
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
          className={`flex items-center gap-2 border-b px-5 py-5 ${isLight ? 'border-brand-100' : 'border-brand-800'} ${collapsed ? 'lg:justify-center lg:px-0' : ''}`}
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

        <p className={`px-5 pb-3 pt-4 text-xs leading-tight ${isLight ? 'text-brand-300' : 'text-brand-300'} ${collapsed ? 'lg:hidden' : ''}`}>
          {subtitle}
        </p>

        <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
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

        <div className={`border-t px-3 py-4 ${isLight ? 'border-brand-100' : 'border-brand-800'} ${collapsed ? 'lg:px-2' : ''}`}>
          <Link
            to={profilePath}
            title={collapsed ? profile?.full_name : undefined}
            onClick={() => setMobileOpen(false)}
            className={`block truncate rounded-lg px-3 py-1 text-xs ${collapsed ? 'lg:hidden' : ''} ${
              isLight ? 'text-brand-400 hover:bg-brand-50 hover:text-brand-800' : 'text-brand-300 hover:bg-white/5 hover:text-white'
            }`}
          >
            {profile?.full_name}
          </Link>
          <Button
            variant={isLight ? 'ghost' : 'ghost-dark'}
            onClick={() => signOut()}
            title={collapsed ? 'Cerrar sesión' : undefined}
            className={`mt-2 w-full ${collapsed ? 'lg:justify-center lg:px-0' : 'justify-start'}`}
          >
            <LogoutIcon width={16} height={16} />
            <span className={collapsed ? 'lg:hidden' : ''}>Cerrar sesión</span>
          </Button>
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto pt-14 lg:pt-0">
        <div className="sticky top-0 z-30 flex items-center justify-end gap-2 border-b border-brand-100 bg-white px-5 py-2.5 lg:px-8">
          <LanguageSwitcher />
          <NotificationsBell theme="light" />
          <Link to={profilePath} className="rounded-full transition-opacity hover:opacity-80">
            <InitialsAvatar name={profile?.full_name ?? '?'} size="sm" />
          </Link>
        </div>
        <div className="p-5 lg:p-8">
          <PageOutlet />
        </div>
      </main>
    </div>
  )
}

function PageOutlet(): ReactNode {
  return <Outlet />
}
