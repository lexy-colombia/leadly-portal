import { useState } from 'react'
import type { Profile } from '../../types/domain'
import { setProfileActive } from '../../lib/api/users'
import { useLanguage } from '../../contexts/LanguageContext'
import type { TranslationKey } from '../../i18n/translations'
import { Badge, Button, EmptyState, InitialsAvatar, Table, TBody, TD, TH, THead, TRow } from '../../components/ui'

const ROLE_LABEL_KEY: Record<string, TranslationKey> = {
  superadmin: 'account.role.superadmin',
  tenant_admin: 'account.role.tenantAdmin',
  tenant_agent: 'account.role.tenantAgent',
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
      <Table bare>
        <THead>
          <tr>
            <TH>{t('account.users.table.user')}</TH>
            <TH>{t('account.users.table.role')}</TH>
            <TH>{t('account.users.table.status')}</TH>
            <TH className="text-right">{t('account.users.table.actions')}</TH>
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
              <TD className="text-brand-500">{user.role in ROLE_LABEL_KEY ? t(ROLE_LABEL_KEY[user.role]) : user.role}</TD>
              <TD>
                <Badge tone={user.active ? 'success' : 'neutral'}>{user.active ? t('common.status.active') : t('common.status.inactive')}</Badge>
              </TD>
              <TD className="text-right">
                <Button
                  variant="ghost"
                  onClick={() => handleToggleActive(user)}
                  disabled={updatingId === user.id || (!user.active && disableActivate)}
                  title={!user.active && disableActivate ? t('account.users.activateDisabled') : undefined}
                  className="!px-3 !py-1.5 text-xs"
                >
                  {updatingId === user.id ? t('common.actions.saving') : user.active ? t('account.users.deactivate') : t('account.users.activate')}
                </Button>
              </TD>
            </TRow>
          ))}
        </TBody>
      </Table>
    </div>
  )
}
