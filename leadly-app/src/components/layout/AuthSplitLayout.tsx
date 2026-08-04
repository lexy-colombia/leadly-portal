import type { ReactNode } from 'react'
import { Logo } from '../brand/Logo'
import { AuthMarketingPanel } from './AuthMarketingPanel'

const CURRENT_YEAR = new Date().getFullYear()

/** Shared shell for every auth screen (login, forgot password, reset password, ...):
 * dark marketing panel on the left (hidden on mobile), white form panel on the right
 * with an optional top-right link and a Lexy Colombia copyright footer. Add new auth
 * pages as children here instead of re-building the split layout per page. */
export function AuthSplitLayout({ topRight, children }: { topRight?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-screen bg-white">
      <AuthMarketingPanel />

      <div className="flex flex-1 flex-col">
        <div className="flex items-center justify-between p-6 sm:p-8">
          <div className="lg:hidden">
            <Logo size="sm" />
          </div>
          <div className="ml-auto">{topRight}</div>
        </div>

        <div className="flex flex-1 items-center justify-center px-6 pb-10 sm:px-8">
          <div className="w-full max-w-md">{children}</div>
        </div>

        <p className="pb-6 text-center text-xs text-brand-300">
          © {CURRENT_YEAR} Leadly. Un producto de Lexy Colombia SAS. Todos los derechos reservados.
        </p>
      </div>
    </div>
  )
}
