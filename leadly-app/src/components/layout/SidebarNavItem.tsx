import { useState, type ComponentType } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { ChevronLeftIcon } from '../icons'

interface ChildNavItem {
  to: string
  label: string
  badge?: string
}

/** `collapsed` only ever narrows the desktop (lg+) rendering -- the mobile
 * off-canvas drawer always shows full labels regardless of the desktop
 * collapse preference, since that's a separate viewport with its own space. */
export function SidebarNavItem({
  to,
  label,
  icon: Icon,
  badge,
  children,
  collapsed = false,
  theme = 'dark',
  onClick,
}: {
  to: string
  label: string
  icon: ComponentType<{ width?: number; height?: number }>
  badge?: string
  children?: ChildNavItem[]
  collapsed?: boolean
  theme?: 'dark' | 'light'
  onClick?: () => void
}) {
  const { pathname } = useLocation()
  const hasChildren = !!children && children.length > 0
  const isChildActive = hasChildren && children.some((c) => pathname === c.to || pathname.startsWith(`${c.to}/`))
  const [open, setOpen] = useState(isChildActive)

  const inactiveClasses =
    theme === 'light' ? 'text-brand-500 hover:bg-brand-50 hover:text-brand-800' : 'text-brand-100 hover:bg-white/5 hover:text-white'
  const badgeClasses = theme === 'light' ? 'bg-amber-100 text-amber-700' : 'bg-amber-400/20 text-amber-300'
  const itemClasses = `group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium transition-all duration-150 ${
    collapsed ? 'lg:justify-center' : ''
  }`

  // Collapsed (icon-only) rail has no room for an expandable submenu -- the
  // group icon becomes a plain shortcut to its first child instead.
  if (hasChildren && collapsed) {
    return (
      <NavLink
        to={children[0].to}
        onClick={onClick}
        title={label}
        className={() => `${itemClasses} ${isChildActive ? 'bg-accent-500 text-white shadow-sm shadow-accent-900/20' : inactiveClasses}`}
      >
        <Icon width={16} height={16} />
      </NavLink>
    )
  }

  if (hasChildren) {
    return (
      <div>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className={`${itemClasses} ${isChildActive ? 'text-brand-800' : inactiveClasses} ${isChildActive && theme === 'light' ? 'bg-brand-50' : ''}`}
        >
          <Icon width={16} height={16} />
          <span className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
            <span className="truncate">{label}</span>
          </span>
          <ChevronLeftIcon width={13} height={13} className={`shrink-0 transition-transform duration-150 ${open ? 'rotate-90' : '-rotate-90'}`} />
        </button>
        {open && (
          <div className="mt-0.5 space-y-0.5 border-l border-current/10 pl-3.5">
            {children.map((child) => (
              <NavLink
                key={child.to}
                to={child.to}
                end
                onClick={onClick}
                className={({ isActive }) =>
                  `flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium transition-all duration-150 ${
                    isActive ? 'bg-accent-500 text-white shadow-sm shadow-accent-900/20' : inactiveClasses
                  }`
                }
              >
                <span className="flex min-w-0 flex-1 items-center gap-1.5">
                  <span className="truncate">{child.label}</span>
                  {child.badge && (
                    <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide ${badgeClasses}`}>
                      {child.badge}
                    </span>
                  )}
                </span>
              </NavLink>
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <NavLink
      to={to}
      end
      onClick={onClick}
      title={collapsed ? label : undefined}
      className={({ isActive }) =>
        `${itemClasses} ${isActive ? 'bg-accent-500 text-white shadow-sm shadow-accent-900/20' : inactiveClasses}`
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
