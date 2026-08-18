import { useState, type ComponentType } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import {
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from '@/components/ui/sidebar'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { ChevronLeftIcon } from '@/components/atoms/icons'

export interface NavItem {
  to: string
  label: string
  icon: ComponentType<{ width?: number; height?: number }>
  /** Small pill after the label, e.g. "BETA" for features that are visible
   * but intentionally locked (Campañas, Catálogo) -- signals "coming soon",
   * not a permissions error. */
  badge?: string
  /** One level of nested items, rendered as a collapsible group (e.g. "CRM").
   * A parent with children is a pure grouping label, not a page of its own
   * -- its `to` is only used to decide which group to auto-expand and is
   * excluded from page-title resolution in AppShell, so it never competes
   * with one of its children for the header title. */
  children?: NavItem[]
}

// Translucent tint instead of shadcn's default opaque `bg-sidebar-accent`
// fill for the active state -- reference: Lexy's sidebar (2026-08-17),
// tuned up once from an initial too-faint /15 pass. `data-active:` is the
// custom variant shadcn/tailwind.css already defines (targets
// [data-active]:not([data-active="false"])) -- SidebarMenuButton and
// SidebarMenuSubButton both already set that attribute from their own
// `isActive` prop, so this only needs to override the color, not wire up
// any new plumbing.
const ACTIVE_CLASSES = 'data-active:bg-accent-500/30 data-active:font-semibold data-active:text-white data-active:hover:bg-accent-500/30'

// shadcn's default SidebarMenuButton size ("default": h-8, text-sm, and a
// [&_svg]:size-4 icon rule baked into the shared variant classes, so a
// smaller icon passed as a plain width/height prop gets overridden back up
// to 16px unless this is repeated here too) read noticeably larger than the
// original hand-rolled nav (text-[13px], 16px icons in a shorter row).
// `size="sm"` gets the row height/text down to a closer match; the icon
// rule still needs its own override on top of that.
const ITEM_CLASSES = `${ACTIVE_CLASSES} [&_svg]:size-3.5`

function ItemIcon({ icon: Icon }: { icon: ComponentType<{ width?: number; height?: number }> }) {
  return <Icon width={14} height={14} />
}

/** Leaf nav item -- exact-path match only (`end`), same as the original
 * SidebarNavItem: a detail route one level below a list page (e.g.
 * /app/clients/:id) does not keep the "Clients" leaf highlighted, only the
 * list page itself does. Group *children* use the same exact-match rule;
 * only the group *header* (see NavGroup below) matches by prefix, so it
 * stays expanded/highlighted while viewing one of its children's detail
 * pages. */
function NavLeaf({ item, onNavigate }: { item: NavItem; onNavigate: () => void }) {
  const { pathname } = useLocation()
  const isActive = pathname === item.to

  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={isActive} tooltip={item.label} size="sm" className={ITEM_CLASSES}>
        <NavLink to={item.to} end onClick={onNavigate}>
          <ItemIcon icon={item.icon} />
          <span>{item.label}</span>
          {item.badge && (
            <SidebarMenuBadge className="static ml-auto shrink-0 rounded-full bg-amber-400/20 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-amber-300">
              {item.badge}
            </SidebarMenuBadge>
          )}
        </NavLink>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

function NavGroup({ item, onNavigate }: { item: NavItem; onNavigate: () => void }) {
  const { pathname } = useLocation()
  const { state } = useSidebar()
  const children = item.children!
  // Prefix-matching (pathname.startsWith(`${c.to}/`)) is only meaningful for
  // a child that is its own real section with sub-pages (e.g. /app/opportunities
  // matching /app/opportunities/:id). It is never meaningful for the bare
  // index route (Conversaciones, to: "/app") -- every single tenant page
  // starts with "/app/", so without this guard that one child silently
  // prefix-matched every route in the app, making the CRM group render as
  // "active" on every page, not just Conversaciones. Same reasoning would
  // apply to "/backoffice" if a backoffice nav ever grew a group.
  const isChildActive = children.some(
    (c) => pathname === c.to || (c.to !== '/app' && c.to !== '/backoffice' && pathname.startsWith(`${c.to}/`)),
  )
  const [open, setOpen] = useState(isChildActive)

  // Collapsed (icon-only) rail has no room for an expandable submenu -- the
  // group icon becomes a plain shortcut to its first child instead, same as
  // the original SidebarNavItem. No shadcn primitive covers this by itself,
  // it is entirely this app's own behavior layered on top of `useSidebar()`.
  if (state === 'collapsed') {
    return (
      <SidebarMenuItem>
        <SidebarMenuButton asChild isActive={isChildActive} tooltip={item.label} size="sm" className={ITEM_CLASSES}>
          <NavLink to={children[0].to} onClick={onNavigate}>
            <ItemIcon icon={item.icon} />
            <span>{item.label}</span>
          </NavLink>
        </SidebarMenuButton>
      </SidebarMenuItem>
    )
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <SidebarMenuItem>
        <CollapsibleTrigger asChild>
          <SidebarMenuButton isActive={isChildActive} size="sm" className={ITEM_CLASSES}>
            <ItemIcon icon={item.icon} />
            <span className="flex-1 text-left">{item.label}</span>
            <ChevronLeftIcon width={13} height={13} className={`shrink-0 transition-transform duration-150 ${open ? 'rotate-90' : '-rotate-90'}`} />
          </SidebarMenuButton>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub>
            {children.map((child) => {
              const childActive = pathname === child.to
              return (
                <SidebarMenuSubItem key={child.to}>
                  <SidebarMenuSubButton asChild isActive={childActive} size="sm" className={ITEM_CLASSES}>
                    <NavLink to={child.to} end onClick={onNavigate}>
                      <span>{child.label}</span>
                    </NavLink>
                  </SidebarMenuSubButton>
                </SidebarMenuSubItem>
              )
            })}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  )
}

export function AppSidebarNav({ navItems }: { navItems: NavItem[] }) {
  // Closes the mobile offcanvas Sheet after a nav click -- Radix's Sheet
  // doesn't auto-close on an internal link click, only on Escape/overlay
  // click/explicit trigger, so this replicates the original hand-rolled
  // shell's `onClick={() => setMobileOpen(false)}`. No-op on desktop.
  const { isMobile, setOpenMobile } = useSidebar()
  const onNavigate = () => {
    if (isMobile) setOpenMobile(false)
  }

  return (
    <SidebarMenu>
      {navItems.map((item) =>
        item.children && item.children.length > 0 ? (
          <NavGroup key={item.to} item={item} onNavigate={onNavigate} />
        ) : (
          <NavLeaf key={item.to} item={item} onNavigate={onNavigate} />
        ),
      )}
    </SidebarMenu>
  )
}
