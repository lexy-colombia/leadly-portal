import { Navigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { PageSpinner } from '../components/ui'
import { roleHome } from './guards'

/** Landing point right after login (and for "/"): sends the user to the layout
 * that matches their role, or to onboarding if they have no tenant yet. */
export function RootRedirect() {
  const { session, profile, loading, unprovisioned } = useAuth()

  if (loading) return <PageSpinner />
  if (!session) return <Navigate to="/login" replace />
  if (unprovisioned) return <Navigate to="/create-company" replace />

  return <Navigate to={roleHome(profile?.role)} replace />
}
