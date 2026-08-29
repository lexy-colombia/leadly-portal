import type { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import type { UserRole } from '../types/domain'
import { PageSpinner } from '@/components/atoms'
import { AccessDenied, TenantDeactivated } from '@/components/organisms'
export function roleHome(role: UserRole | undefined): string {
  return role === 'superadmin' ? '/backoffice' : '/app'
}

/** Redirects to /login when there is no active session, to /create-company when the
 * auth.users row exists but no profiles row matches it yet, and shows a hard lock
 * screen (not a redirect) when the caller's tenant was deactivated by a superadmin --
 * the RLS layer already blocks their data via auth_active_tenant_id(), this is just
 * the friendly explanation instead of an app that looks broken. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { session, loading, unprovisioned, profile, tenant, signOut } = useAuth()

  if (loading) {
    return <PageSpinner />
  }

  if (!session) {
    return <Navigate to="/login" replace />
  }

  if (unprovisioned) {
    return <Navigate to="/create-company" replace />
  }

  if (profile?.role !== 'superadmin' && tenant?.status === 'inactive') {
    return <TenantDeactivated tenantName={tenant.name} onSignOut={signOut} />
  }

  return <>{children}</>
}

/** Restricts a route subtree to a set of roles. Shows an explicit "acceso denegado"
 * screen in place instead of redirecting -- a direct URL hit on a section the caller
 * can't use must show a lock, not silently bounce them somewhere else. */
export function RequireRole({ allowed, children }: { allowed: UserRole[]; children: ReactNode }) {
  const { profile, loading } = useAuth()

  if (loading) {
    return <PageSpinner />
  }

  if (!profile || !allowed.includes(profile.role)) {
    return <AccessDenied />
  }

  return <>{children}</>
}

/** Gates a single tenant-panel route behind one of TENANT_MODULES's keys (see
 * lib/modules.ts) -- same "lock in place, don't redirect" shape as RequireRole,
 * for the same reason: a direct URL hit on a module the superadmin turned off
 * for this tenant must show a lock, not silently bounce or (worse) render the
 * page. `enabledModules` is null only for superadmin (never reaches /app
 * routes) or while AuthContext is still loading -- both already covered by
 * `loading` here, so a null set past that point reads as "nothing enabled".
 *
 * `action` (2026-08-29) additionally gates the route behind one action key
 * from permission_actions (see lib/api/permissions.ts) -- a tenant_agent
 * whose tenant_role doesn't grant it hits the same lock screen, not just
 * hidden buttons once inside. superadmin/tenant_admin always pass (their
 * `permissions` set is the full catalog, see listMyPermissionKeys). Only
 * the module's own "view" action belongs here -- finer actions (create/
 * edit/delete/...) stay button-level via usePermission, not a route lock. */
export function RequireModule({ moduleKey, action, children }: { moduleKey: string; action?: string; children: ReactNode }) {
  const { enabledModules, permissions, loading } = useAuth()

  if (loading) {
    return <PageSpinner />
  }

  if (!enabledModules?.has(moduleKey)) {
    return <AccessDenied />
  }

  if (action && !permissions?.has(action)) {
    return <AccessDenied />
  }

  return <>{children}</>
}
