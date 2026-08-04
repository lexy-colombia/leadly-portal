import { useState } from 'react'
import type { Profile } from '../../types/domain'
import { setProfileActive } from '../../lib/api/users'
import { Badge, Button, EmptyState, InitialsAvatar, Table, TBody, TD, TH, THead, TRow } from '../../components/ui'

const ROLE_LABEL: Record<string, string> = {
  superadmin: 'Superadmin',
  tenant_admin: 'Administrador',
  tenant_agent: 'Agente',
}

/** Shared between the backoffice (Cliente → Usuarios) and the tenant panel
 * (Usuarios) -- same list, same toggle, only which tenant's users get fetched
 * differs by caller. */
export function UsersTable({ users, onChange }: { users: Profile[]; onChange: (p: Profile) => void }) {
  const [updatingId, setUpdatingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function handleToggleActive(user: Profile) {
    setUpdatingId(user.id)
    setError(null)
    try {
      onChange(await setProfileActive(user.id, !user.active))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo actualizar el usuario.')
    } finally {
      setUpdatingId(null)
    }
  }

  if (users.length === 0) {
    return <EmptyState>Todavía no hay usuarios invitados.</EmptyState>
  }

  return (
    <div className="space-y-3">
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <Table bare>
        <THead>
          <tr>
            <TH>Usuario</TH>
            <TH>Rol</TH>
            <TH>Estado</TH>
            <TH className="text-right">Acciones</TH>
          </tr>
        </THead>
        <TBody>
          {users.map((user) => (
            <TRow key={user.id}>
              <TD>
                <div className="flex items-center gap-3">
                  <InitialsAvatar name={user.full_name} size="sm" />
                  <div>
                    <p className="font-medium text-brand-800">{user.full_name}</p>
                    <p className="text-xs text-brand-400">{user.email}</p>
                  </div>
                </div>
              </TD>
              <TD className="text-brand-500">{ROLE_LABEL[user.role] ?? user.role}</TD>
              <TD>
                <Badge tone={user.active ? 'success' : 'neutral'}>{user.active ? 'Activo' : 'Inactivo'}</Badge>
              </TD>
              <TD className="text-right">
                <Button
                  variant="ghost"
                  onClick={() => handleToggleActive(user)}
                  disabled={updatingId === user.id}
                  className="!px-3 !py-1.5 text-xs"
                >
                  {updatingId === user.id ? 'Guardando…' : user.active ? 'Desactivar' : 'Activar'}
                </Button>
              </TD>
            </TRow>
          ))}
        </TBody>
      </Table>
    </div>
  )
}
