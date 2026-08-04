import type { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import type { UserRole } from '../types/domain'
import { AccessDenied, PageSpinner, TenantDeactivated } from '../components/ui'

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
