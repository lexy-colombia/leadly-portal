import { createContext, useContext, useState, type ReactNode } from 'react'

interface HeaderSearchSlotContextValue {
  slot: HTMLDivElement | null
  setSlot: (el: HTMLDivElement | null) => void
}

const HeaderSearchSlotContext = createContext<HeaderSearchSlotContextValue | undefined>(undefined)

/** Lets a routed page (e.g. Products.tsx) render its search box inside the
 * shared AppShell header bar instead of its own toolbar -- AppShell owns
 * the actual header DOM node and can't reach into an Outlet child's JSX,
 * so the page portals into a node AppShell exposes here instead. `slot`
 * starts null (AppShell's header div hasn't committed/attached its ref
 * yet on first render) and flips to the real element via a state-backed
 * ref once it has -- a plain useRef wouldn't trigger the re-render a
 * consumer needs to notice it became available. Scoped to AppShell (wraps
 * its own return), not the whole app, since only pages rendered inside a
 * layout with this header have anywhere to portal into. */
export function HeaderSearchSlotProvider({ children }: { children: ReactNode }) {
  const [slot, setSlot] = useState<HTMLDivElement | null>(null)
  return <HeaderSearchSlotContext.Provider value={{ slot, setSlot }}>{children}</HeaderSearchSlotContext.Provider>
}

export function useHeaderSearchSlot() {
  const ctx = useContext(HeaderSearchSlotContext)
  if (!ctx) throw new Error('useHeaderSearchSlot must be used within HeaderSearchSlotProvider')
  return ctx
}
