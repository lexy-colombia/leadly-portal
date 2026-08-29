import { useEffect, useState } from 'react'
import { listProfilesByTenant } from '../../../lib/api/users'
import type { Profile } from '../../../types/domain'
import { useLanguage } from '../../../contexts/LanguageContext'
import { PageSpinner } from '@/components/atoms'
import { Button } from '@/components/ui/button'
import { PlusIcon } from '@/components/atoms/icons'
import { UserInviteDrawer } from '../../shared/UserInviteDrawer'
import { UsersTable } from '../../shared/UsersTable'

/** Autogestión de usuarios del tenant -- hasta ahora invitar/gestionar
 * usuarios de un tenant solo era posible desde el backoffice (superadmin),
 * aunque UserInviteDrawer/UsersTable ya estaban escritos para soportar
 * ambos casos. Montado en Settings.tsx, admin-only. */
export function UsersSection({ tenantId }: { tenantId: string }) {
  const { t } = useLanguage()
  const [users, setUsers] = useState<Profile[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [inviteOpen, setInviteOpen] = useState(false)

  useEffect(() => {
    listProfilesByTenant(tenantId)
      .then(setUsers)
      .catch((err) => setError(err instanceof Error ? err.message : t('account.users.errors.updateFailed')))
  }, [tenantId, t])

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button type="button" size="sm" onClick={() => setInviteOpen(true)}>
          <PlusIcon width={14} height={14} /> {t('account.invite.title')}
        </Button>
      </div>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {!users && !error && <PageSpinner />}
      {users && <UsersTable users={users} onChange={(u) => setUsers((prev) => (prev ? prev.map((p) => (p.id === u.id ? u : p)) : prev))} />}

      <UserInviteDrawer open={inviteOpen} onClose={() => setInviteOpen(false)} tenantId={tenantId} onInvited={(p) => setUsers((prev) => [p, ...(prev ?? [])])} />
    </div>
  )
}
