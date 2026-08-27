import { useState } from 'react'
import type { Profile } from '../../types/domain'
import { setProfileActive } from '../../lib/api/users'
import { useLanguage } from '../../contexts/LanguageContext'
import type { TranslationKey } from '../../i18n/translations'
import { InitialsAvatar } from '@/components/atoms'
import { EmptyState } from '@/components/molecules'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
const ROLE_LABEL_KEY: Record<string, TranslationKey> = {
  superadmin: 'account.role.superadmin',
  tenant_admin: 'account.role.tenantAdmin',
  tenant_agent: 'account.role.tenantAgent',
}

// bg/text pair on top of shadcn Badge's `outline` variant -- same pattern as
// Clients.tsx's STAGE_BADGE_CLASS, shadcn's own variants have no
// "success"/"neutral" tone like the legacy atoms Badge this replaces.
const ACTIVE_BADGE_CLASS: Record<'active' | 'inactive', string> = {
  active: 'border-transparent bg-emerald-100 text-emerald-700',
  inactive: 'border-transparent bg-slate-100 text-slate-600',
}

/** Shared between the backoffice (Cliente → Usuarios) and the tenant panel
 * (Usuarios) -- same list, same toggle, only which tenant's users get fetched
 * differs by caller. `disableActivate` blocks only the reactivation action
 * (deactivating always stays available) when the tenant's plan is already at
 * its max active users -- the actual enforcement is a DB trigger
 * (enforce_plan_max_users), this is just proactive UI so the click doesn't
 * have to round-trip to fail. */
export function UsersTable({
  users,
  onChange,
  disableActivate = false,
}: {
  users: Profile[]
  onChange: (p: Profile) => void
  disableActivate?: boolean
}) {
  const { t } = useLanguage()
  const [updatingId, setUpdatingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function handleToggleActive(user: Profile) {
    setUpdatingId(user.id)
    setError(null)
    try {
      onChange(await setProfileActive(user.id, !user.active))
    } catch (err) {
      setError(err instanceof Error ? err.message : t('account.users.errors.updateFailed'))
    } finally {
      setUpdatingId(null)
    }
  }

  if (users.length === 0) {
    return <EmptyState>{t('account.users.empty')}</EmptyState>
  }

  return (
    <div className="space-y-3">
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <div className="overflow-hidden rounded-2xl border border-brand-100 bg-white">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('account.users.table.user')}</TableHead>
              <TableHead>{t('account.users.table.role')}</TableHead>
              <TableHead>{t('account.users.table.status')}</TableHead>
              <TableHead className="text-right">{t('account.users.table.actions')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((user) => (
              <TableRow key={user.id}>
                <TableCell>
                  <div className="flex items-center gap-3">
                    <InitialsAvatar name={user.full_name} size="sm" />
                    <div>
                      <p className="font-medium text-brand-800">{user.full_name}</p>
                      <p className="text-xs text-brand-400">{user.email}</p>
                    </div>
                  </div>
                </TableCell>
                <TableCell className="text-brand-500">{user.role in ROLE_LABEL_KEY ? t(ROLE_LABEL_KEY[user.role]) : user.role}</TableCell>
                <TableCell>
                  <Badge variant="outline" className={ACTIVE_BADGE_CLASS[user.active ? 'active' : 'inactive']}>
                    {user.active ? t('common.status.active') : t('common.status.inactive')}
                  </Badge>
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => handleToggleActive(user)}
                    disabled={updatingId === user.id || (!user.active && disableActivate)}
                    title={!user.active && disableActivate ? t('account.users.activateDisabled') : undefined}
                  >
                    {updatingId === user.id ? t('common.actions.saving') : user.active ? t('account.users.deactivate') : t('account.users.activate')}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
