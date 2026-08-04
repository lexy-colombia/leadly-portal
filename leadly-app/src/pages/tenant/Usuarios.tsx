import { useEffect, useState } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { listProfilesByTenant } from '../../lib/api/users'
import type { Profile } from '../../types/domain'
import { AccessDenied, Button, Card, PageSpinner } from '../../components/ui'
import { PlusIcon } from '../../components/icons'
import { UserInviteDrawer } from '../shared/UserInviteDrawer'
import { UsersTable } from '../shared/UsersTable'

export function Usuarios() {
  const { profile } = useAuth()
  const [users, setUsers] = useState<Profile[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [inviteOpen, setInviteOpen] = useState(false)

  function reload() {
    if (!profile?.tenant_id) return
    listProfilesByTenant(profile.tenant_id)
      .then(setUsers)
      .catch((err) => setError(err.message ?? 'No se pudieron cargar los usuarios.'))
  }

  useEffect(reload, [profile?.tenant_id])

  // TenantLayout's route-level RequireRole allows both tenant_admin and
  // tenant_agent into /app/*, but "Usuarios" is admin-only (it's not even in
  // tenant_agent's nav) -- a direct URL hit still needs an explicit lock,
  // not a silent redirect.
  if (profile?.role !== 'tenant_admin') {
    return <AccessDenied />
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-brand-800 sm:text-2xl">Usuarios</h1>
          <p className="text-sm text-brand-400">Invita a tu equipo a usar Leadly.</p>
        </div>
        <Button variant="secondary" onClick={() => setInviteOpen(true)}>
          <PlusIcon width={16} height={16} /> Invitar usuario
        </Button>
      </div>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {!users && !error && <PageSpinner />}
      {users && (
        <Card>
          <UsersTable users={users} onChange={(u) => setUsers((prev) => prev!.map((p) => (p.id === u.id ? u : p)))} />
        </Card>
      )}

      {profile?.tenant_id && (
        <UserInviteDrawer
          open={inviteOpen}
          onClose={() => setInviteOpen(false)}
          tenantId={profile.tenant_id}
          onInvited={(p) => setUsers((prev) => [p, ...(prev ?? [])])}
        />
      )}
    </div>
  )
}
