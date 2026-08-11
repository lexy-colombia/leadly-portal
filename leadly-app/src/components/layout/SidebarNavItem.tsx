import { NavLink } from 'react-router-dom'
import type { ComponentType } from 'react'

/** `collapsed` only ever narrows the desktop (lg+) rendering -- the mobile
 * off-canvas drawer always shows full labels regardless of the desktop
 * collapse preference, since that's a separate viewport with its own space. */
export function SidebarNavItem({
  to,
  label,
  icon: Icon,
  badge,
  collapsed = false,
  theme = 'dark',
  onClick,
}: {
  to: string
  label: string
  icon: ComponentType<{ width?: number; height?: number }>
  badge?: string
  collapsed?: boolean
  theme?: 'dark' | 'light'
  onClick?: () => void
}) {
  const inactiveClasses =
    theme === 'light' ? 'text-brand-500 hover:bg-brand-50 hover:text-brand-800' : 'text-brand-100 hover:bg-white/5 hover:text-white'
  const badgeClasses = theme === 'light' ? 'bg-amber-100 text-amber-700' : 'bg-amber-400/20 text-amber-300'

  return (
    <NavLink
      to={to}
      end
      onClick={onClick}
      title={collapsed ? label : undefined}
      className={({ isActive }) =>
        `group flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium transition-all duration-150 ${
          collapsed ? 'lg:justify-center' : ''
        } ${isActive ? 'bg-accent-500 text-white shadow-sm shadow-accent-900/20' : inactiveClasses}`
      }
    >
      <Icon width={16} height={16} />
      <span className={`flex min-w-0 flex-1 items-center gap-1.5 ${collapsed ? 'lg:hidden' : ''}`}>
        <span className="truncate">{label}</span>
        {badge && (
          <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide ${badgeClasses}`}>
            {badge}
          </span>
        )}
      </span>
    </NavLink>
  )
}
