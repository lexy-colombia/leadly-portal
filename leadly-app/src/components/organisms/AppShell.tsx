import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, Outlet, useLocation } from 'react-router-dom'
import changelogRaw from '../../../CHANGELOG.md?raw'
import { useAuth } from '@/contexts/AuthContext'
import { useLanguage } from '@/contexts/LanguageContext'
import { HeaderSearchSlotProvider, useHeaderSearchSlot } from '@/contexts/HeaderSearchSlotContext'
import { AppSidebarNav, type NavItem } from './AppSidebarNav'
import { NotificationsBell } from './NotificationsBell'
import { LanguageSwitcher } from './LanguageSwitcher'
import { Button, InitialsAvatar } from '@/components/atoms'
import { Logo } from '@/components/atoms/Logo'
import { ChevronLeftIcon, LogoutIcon, MenuIcon } from '@/components/atoms/icons'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarProvider,
  useSidebar,
} from '@/components/ui/sidebar'
import { TooltipProvider } from '@/components/ui/tooltip'

export type { NavItem }

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

const COLLAPSE_STORAGE_KEY = 'leadly:sidebar-collapsed'

// Every page used to render its own "<h1>Title</h1><p>description</p>" block,
// which duplicated the nav label right below it and added a lot of repeated
// boilerplate across every page. Pages no longer render a title at all --
// this derives it from whichever nav item's route path is the longest match
// for the current URL (so a detail route like /app/clients/:id still shows
// "Clients", the nav item it lives under), with the two routes that aren't
// in the nav (account, changelog) special-cased since they're shared between
// both layouts. When the match is a nested route (a "detail" page one level
// below its list, e.g. /app/clients/:id under /app/clients), `backTo` is
// set so the header renders a clickable "← Clients" instead of a plain
// title -- pages no longer need their own "Volver a ..." link in the body.
function resolvePageTitle(
  pathname: string,
  navItems: NavItem[],
  specialTitles: { account: string; whatsNew: string },
): { title: string; badge?: string; backTo?: string } {
  if (pathname.endsWith('/account')) return { title: specialTitles.account }
  if (pathname.endsWith('/changelog')) return { title: specialTitles.whatsNew }

  // Flatten one level so a grouped item's children (e.g. "Clients" inside
  // "CRM") still resolve to a real page title -- only leaf items (no
  // children of their own) are real pages, so the parent's own `to` is
  // excluded here even though it's still used for auto-expand elsewhere.
  const candidates = navItems.flatMap((item) => (item.children && item.children.length > 0 ? item.children : [item]))
  const matches = candidates.filter((item) => pathname === item.to || pathname.startsWith(`${item.to}/`))
  const best = matches.reduce<NavItem | null>((longest, item) => (!longest || item.to.length > longest.to.length ? item : longest), null)
  if (!best) return { title: '' }
  return { title: best.label, badge: best.badge, backTo: pathname !== best.to ? best.to : undefined }
}

/** Fixed top bar, mobile only -- its hamburger opens the shadcn Sidebar's
 * built-in offcanvas Sheet via `toggleSidebar()` (branches to mobile mode
 * automatically inside useSidebar, same call the desktop collapse button
 * uses). Rendered as a sibling of <Sidebar>/<SidebarInset>, both of which
 * are direct children of SidebarProvider, so needs its own small component
 * to reach `useSidebar()` -- AppShell itself renders the Provider and can't
 * call the hook above it.
 *
 * Hidden via the same `isMobile` the Sidebar component itself switches on
 * (shadcn's useIsMobile hook, a fixed 768px/Tailwind-`md` check), not a
 * `lg:hidden` class -- the desktop icon-rail is already visible from `md`
 * up (collapsible="icon" never fully hides it), so a `lg:`-gated (1024px)
 * bar would float redundantly on top of it between 768-1024px. */
function MobileTopBar({ isLight }: { isLight: boolean }) {
  const { toggleSidebar, isMobile } = useSidebar()
  const { t } = useLanguage()
  if (!isMobile) return null
  return (
    <div
      className={`fixed inset-x-0 top-0 z-40 flex h-14 items-center justify-between border-b px-4 ${
        isLight ? 'border-brand-100 bg-white' : 'border-brand-800 bg-brand-700'
      }`}
    >
      <Logo size="sm" onDark={!isLight} />
      <button
        type="button"
        onClick={toggleSidebar}
        aria-label={t('common.shell.openMenu')}
        className={isLight ? '-mr-2 p-2 text-brand-500 hover:text-brand-800' : '-mr-2 p-2 text-brand-100 hover:text-white'}
      >
        <MenuIcon />
      </button>
    </div>
  )
}

/** Desktop-only icon-collapse toggle, inside the sidebar's own header --
 * same `toggleSidebar()` as the mobile hamburger. `Sidebar` renders this
 * same header inside the mobile Sheet too (same `children`), so this needs
 * its own `isMobile` check to hide there -- collapsing to an icon rail
 * makes no sense inside a full-width mobile overlay panel. Checked in JS
 * (not a `lg:hidden` class) for the same reason as MobileTopBar: it has to
 * match Sidebar's own 768px/`md` breakpoint exactly, not float on a
 * different one. */
function CollapseToggle({ isLight }: { isLight: boolean }) {
  const { toggleSidebar, state, isMobile } = useSidebar()
  const { t } = useLanguage()
  if (isMobile) return null
  const collapsed = state === 'collapsed'
  return (
    <button
      type="button"
      onClick={toggleSidebar}
      aria-label={collapsed ? t('common.shell.expandMenu') : t('common.shell.collapseMenu')}
      className={`ml-auto rounded-lg p-1.5 ${
        isLight ? 'text-brand-400 hover:bg-brand-50 hover:text-brand-800' : 'text-brand-300 hover:bg-brand-600 hover:text-white'
      }`}
    >
      <ChevronLeftIcon className={`transition-transform duration-200 ${collapsed ? 'rotate-180' : ''}`} />
    </button>
  )
}

/** Sign-out + version link, in the sidebar footer -- reads `state`/`isMobile`
 * for the same collapsed-icon-only layout tweaks the original hand-rolled
 * shell had (hide labels, center icons). The account name/avatar link used
 * to live here too; moved to the header (see HeaderAccountLink) so profile
 * identity reads as "who's using this session" at the top of every page,
 * not tucked away below the nav -- 2026-08-17. */
function AccountFooter({
  isLight,
  changelogPath,
}: {
  isLight: boolean
  changelogPath: string
}) {
  const { signOut } = useAuth()
  const { t } = useLanguage()
  const { state, isMobile, setOpenMobile } = useSidebar()
  const collapsed = state === 'collapsed'
  // Same reasoning as AppSidebarNav's onNavigate: Radix's Sheet needs an
  // explicit close call on internal link clicks.
  const onNavigate = () => {
    if (isMobile) setOpenMobile(false)
  }

  return (
    <>
      <Button
        variant={isLight ? 'ghost' : 'ghost-dark'}
        onClick={() => signOut()}
        title={collapsed ? t('common.shell.logout') : undefined}
        className={`w-full !py-1.5 text-xs ${collapsed ? 'lg:justify-center lg:px-0' : 'justify-start'}`}
      >
        <LogoutIcon width={13} height={13} />
        <span className={collapsed ? 'lg:hidden' : ''}>{t('common.shell.logout')}</span>
      </Button>
      {CURRENT_VERSION && (
        <Link
          to={changelogPath}
          onClick={onNavigate}
          title={collapsed ? `${t('common.shell.version')} ${CURRENT_VERSION} · ${t('common.shell.whatsNew')}` : undefined}
          className={`mt-1.5 block truncate text-center text-[10px] ${collapsed ? 'lg:hidden' : ''} ${
            isLight ? 'text-brand-300 hover:text-brand-600' : 'text-brand-400 hover:text-brand-200'
          }`}
        >
          v{CURRENT_VERSION} · {t('common.shell.whatsNew')}
        </Link>
      )}
    </>
  )
}

/** Empty by default -- a routed page (see useHeaderSearchSlot) can portal
 * its search box in here so it lives in the fixed header bar instead of the
 * page's own scrolling content, without AppShell needing to know which page
 * that is. Centered between the title and the account/notifications group;
 * collapses back to zero width itself once its content (the portaled input)
 * unmounts, e.g. navigating off a page that uses it. */
function HeaderSearchSlot() {
  const { setSlot } = useHeaderSearchSlot()
  return <div ref={setSlot} className="flex min-w-0 flex-1 justify-center px-2 sm:px-4" />
}

/** Profile identity in the header bar, next to the language switcher and
 * notification bell -- replaces the old sidebar-footer account link.
 * Header bg is always white regardless of sidebar theme (see NotificationsBell's
 * hardcoded theme="light" a few lines down), so this doesn't need an
 * isLight branch of its own. Name hides below `sm` to leave room for the
 * page title on narrow phones -- the avatar alone still links to /account. */
function HeaderAccountLink({ profilePath }: { profilePath: string }) {
  const { profile } = useAuth()
  return (
    <Link to={profilePath} className="flex shrink-0 items-center gap-2 rounded-lg py-1 pl-1 pr-2 hover:bg-brand-50">
      <InitialsAvatar name={profile?.full_name ?? '?'} size="sm" />
      <span className="hidden max-w-[10rem] truncate text-xs font-semibold text-brand-800 sm:block">{profile?.full_name}</span>
    </Link>
  )
}

/** Shared responsive shell for both BackofficeLayout and TenantLayout, built
 * on shadcn's Sidebar primitive (migrated 2026-08-17, previously a fully
 * hand-rolled <aside>). Desktop icon-collapse and mobile offcanvas both come
 * from SidebarProvider/useSidebar instead of two separate hand-rolled state
 * machines; content area is fluid (no max-width) so it uses all the space
 * next to the sidebar.
 *
 * `theme` still exists for API compatibility (TenantLayout/BackofficeLayout
 * pass it unchanged), but only the dark-navy chrome is actually reachable
 * from the UI today (both layouts pass "dark") -- the shadcn Sidebar itself
 * is pinned to the navy `--sidebar-*` tokens in index.css regardless of this
 * prop, since building real light/dark theming was explicitly out of scope
 * for this migration. `isLight` below only adjusts the few chrome pieces
 * that live outside the token-driven Sidebar (mobile top bar, footer text).
 * The accent pill on the active nav item stays Leadly's turquoise either
 * way -- see AppSidebarNav's ACTIVE_CLASSES. */
export function AppShell({
  subtitle,
  navItems,
  theme = 'dark',
}: {
  subtitle: string
  navItems: NavItem[]
  theme?: 'dark' | 'light'
}) {
  const { t } = useLanguage()
  const location = useLocation()
  const basePath = location.pathname.startsWith('/backoffice') ? '/backoffice' : '/app'
  const profilePath = `${basePath}/account`
  const changelogPath = `${basePath}/changelog`
  const pageHeader = useMemo(
    () => resolvePageTitle(location.pathname, navItems, { account: t('common.shell.myAccount'), whatsNew: t('common.shell.whatsNew') }),
    [location.pathname, navItems, t],
  )
  const isLight = theme === 'light'
  // Inbox (the tenant's index route, "/app") is the one page that manages
  // its own internal scrolling -- a two-pane chat layout with an
  // independently scrollable conversation list and message thread, each
  // capped to the available height. Every other route just wants to grow
  // naturally and let this wrapper be the one scrollbar for the whole
  // page, so the padded/auto-scroll treatment stays the default; this is
  // the single opt-out. Without it, this wrapper's own overflow-y-auto
  // was the only scroll container, so the whole page (sidebar list +
  // every message) scrolled together as one long column instead of the
  // list and the thread scrolling independently (explicit bug report).
  const isFullBleed = location.pathname === '/app'

  // Same leadly:-prefixed localStorage key the hand-rolled shell already
  // used -- kept as the single source of truth for collapse persistence
  // instead of also adopting shadcn's own cookie-based default, so there's
  // one persistence mechanism, not two disagreeing ones. `open` here means
  // *expanded* (shadcn's naming), the inverse of the old `collapsed` bit.
  const [open, setOpen] = useState(() => localStorage.getItem(COLLAPSE_STORAGE_KEY) !== '1')
  useEffect(() => {
    localStorage.setItem(COLLAPSE_STORAGE_KEY, open ? '0' : '1')
  }, [open])

  return (
    <TooltipProvider delayDuration={300}>
      <HeaderSearchSlotProvider>
      <SidebarProvider open={open} onOpenChange={setOpen} className="bg-[var(--color-surface)]">
        <MobileTopBar isLight={isLight} />

        <Sidebar collapsible="icon">
          {/* `relative` + el toggle sacado del flujo con `absolute` (2026-09-02,
              pedido explícito del usuario: "la imagen del sidemenu es pequeña,
              quiero mas grande y que este centrada") -- antes el logo y el
              toggle compartían una fila `flex` normal, así que el `ml-auto`
              del toggle empujaba al logo hacia la izquierda en vez de dejarlo
              centrado. Con el toggle posicionado aparte, el div del logo
              (`flex-1 justify-center`) puede centrarse en todo el ancho del
              header sin que el toggle le gane espacio. */}
          <SidebarHeader
            className={`relative flex-row items-center border-b px-4 py-4 ${isLight ? 'border-brand-100' : 'border-brand-800'} group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0 group-data-[collapsible=icon]:py-3.5`}
          >
            <div className="flex flex-1 justify-center group-data-[collapsible=icon]:hidden">
              <Logo size="nav" onDark={!isLight} />
            </div>
            <div className="absolute right-3 top-1/2 -translate-y-1/2 group-data-[collapsible=icon]:static group-data-[collapsible=icon]:translate-y-0">
              <CollapseToggle isLight={isLight} />
            </div>
          </SidebarHeader>

          <p className="px-4 pb-2 pt-3 text-[11px] leading-tight text-brand-300 group-data-[collapsible=icon]:hidden">{subtitle}</p>

          <SidebarContent className="px-2.5 py-2">
            <AppSidebarNav navItems={navItems} />
          </SidebarContent>

          <SidebarFooter className={`border-t px-2.5 py-2.5 ${isLight ? 'border-brand-100' : 'border-brand-800'} group-data-[collapsible=icon]:px-2`}>
            <AccountFooter isLight={isLight} changelogPath={changelogPath} />
          </SidebarFooter>
        </Sidebar>

        <SidebarInset className="overflow-hidden pt-14 md:pt-0">
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-brand-100 bg-white px-5 py-2.5 lg:px-8">
            <div className="flex min-w-0 items-center gap-2">
              {pageHeader.backTo ? (
                <Link
                  to={pageHeader.backTo}
                  className="flex min-w-0 items-center gap-1 truncate text-sm font-semibold text-brand-800 transition-colors hover:text-accent-700 sm:text-base"
                >
                  <ChevronLeftIcon width={16} height={16} className="shrink-0" />
                  <span className="truncate">{pageHeader.title}</span>
                </Link>
              ) : (
                <h1 className="truncate text-sm font-semibold text-brand-800 sm:text-base">{pageHeader.title}</h1>
              )}
              {pageHeader.badge && (
                <span className="shrink-0 rounded-full bg-amber-100 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-amber-700">
                  {pageHeader.badge}
                </span>
              )}
            </div>
            <HeaderSearchSlot />
            {/* Two groups instead of three loose icons in a row: app-level
                settings (language) on one side of a divider, "about me"
                (notifications, identity) on the other -- reads as
                intentional grouping instead of an unordered icon strip. */}
            <div className="flex shrink-0 items-center gap-2.5">
              <LanguageSwitcher />
              <div className="h-5 w-px bg-brand-100" aria-hidden="true" />
              <div className="flex items-center gap-1">
                <NotificationsBell theme="light" />
                <HeaderAccountLink profilePath={profilePath} />
              </div>
            </div>
          </div>
          <div className={isFullBleed ? 'flex min-h-0 flex-1 flex-col overflow-hidden' : 'min-h-0 flex-1 overflow-y-auto p-5 lg:p-8'}>
            <PageOutlet />
          </div>
        </SidebarInset>
      </SidebarProvider>
      </HeaderSearchSlotProvider>
    </TooltipProvider>
  )
}

function PageOutlet(): ReactNode {
  return <Outlet />
}
