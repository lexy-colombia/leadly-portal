import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
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
  const queryClient = useQueryClient()
  const [inviteOpen, setInviteOpen] = useState(false)

  const query = useQuery<Profile[]>({
    queryKey: ['tenantUsers', tenantId],
    queryFn: () => listProfilesByTenant(tenantId),
  })
  const users = query.data
  const error = query.error instanceof Error ? query.error.message : query.error ? t('account.users.errors.updateFailed') : null

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button type="button" size="sm" onClick={() => setInviteOpen(true)}>
          <PlusIcon width={14} height={14} /> {t('account.invite.title')}
        </Button>
      </div>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
      {query.isLoading && <PageSpinner />}
      {users && (
        <UsersTable
          users={users}
          onChange={(u) =>
            queryClient.setQueryData<Profile[]>(['tenantUsers', tenantId], (prev) => prev?.map((p) => (p.id === u.id ? u : p)) ?? prev)
          }
        />
      )}

      <UserInviteDrawer open={inviteOpen} onClose={() => setInviteOpen(false)} tenantId={tenantId} />
    </div>
  )
}
