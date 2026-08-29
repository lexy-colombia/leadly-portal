import { useEffect, useState } from 'react'
import { deleteTenantRole, listPermissionActions, listTenantRoles } from '../../../lib/api/permissions'
import type { PermissionAction, TenantRole } from '../../../types/domain'
import { useLanguage } from '../../../contexts/LanguageContext'
import { PageSpinner } from '@/components/atoms'
import { EmptyState } from '@/components/molecules'
import { ConfirmDialog } from '@/components/organisms'
import { Button } from '@/components/ui/button'
import { PencilIcon, PlusIcon, TrashIcon } from '@/components/atoms/icons'
import { RoleDrawer } from './RoleDrawer'

/** "Roles y permisos" -- CRUD de tenant_roles + el checklist de acciones de
 * cada uno (RoleDrawer). El tenant se autogestiona esto (a diferencia de
 * Habilidades/Módulos, que solo el superadmin toca), montado en Settings.tsx
 * junto a Usuarios, admin-only. */
export function RolesSection({ tenantId }: { tenantId: string }) {
  const { t } = useLanguage()
  const [roles, setRoles] = useState<TenantRole[] | null>(null)
  const [actions, setActions] = useState<PermissionAction[]>([])
  const [error, setError] = useState<string | null>(null)
  const [drawer, setDrawer] = useState<{ open: boolean; role: TenantRole | null }>({ open: false, role: null })
  const [roleToDelete, setRoleToDelete] = useState<TenantRole | null>(null)
  const [deleting, setDeleting] = useState(false)

  function reload() {
    listTenantRoles(tenantId)
      .then(setRoles)
      .catch((err) => setError(err instanceof Error ? err.message : t('settings.roles.errors.load')))
  }

  useEffect(() => {
    reload()
    listPermissionActions()
      .then(setActions)
      .catch((err) => setError(err instanceof Error ? err.message : t('settings.roles.errors.loadActions')))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId])

  async function handleConfirmDelete() {
    if (!roleToDelete) return
    setDeleting(true)
    try {
      await deleteTenantRole(roleToDelete.id)
      setRoleToDelete(null)
      reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('settings.roles.errors.delete'))
      setRoleToDelete(null)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button type="button" size="sm" onClick={() => setDrawer({ open: true, role: null })}>
          <PlusIcon width={13} height={13} /> {t('settings.roles.new')}
        </Button>
      </div>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {!roles && !error && <PageSpinner />}
      {roles && roles.length === 0 && <EmptyState>{t('settings.roles.empty')}</EmptyState>}

      {roles && roles.length > 0 && (
        <div className="divide-y divide-brand-100 overflow-hidden rounded-2xl border border-brand-100 bg-white">
          {roles.map((role) => (
            <div key={role.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-brand-800">{role.name}</p>
                {role.description && <p className="truncate text-xs text-brand-400">{role.description}</p>}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t('settings.roles.aria.edit')}
                  onClick={() => setDrawer({ open: true, role })}
                >
                  <PencilIcon width={12} height={12} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="text-red-600 hover:bg-red-50"
                  aria-label={t('settings.roles.aria.delete')}
                  onClick={() => setRoleToDelete(role)}
                >
                  <TrashIcon width={12} height={12} />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <RoleDrawer
        open={drawer.open}
        onClose={() => setDrawer({ open: false, role: null })}
        tenantId={tenantId}
        role={drawer.role}
        actions={actions}
        onSaved={() => reload()}
      />

      <ConfirmDialog
        open={!!roleToDelete}
        onClose={() => setRoleToDelete(null)}
        onConfirm={handleConfirmDelete}
        title={t('settings.roles.deleteConfirm.title')}
        description={t('settings.roles.deleteConfirm.description', { name: roleToDelete?.name ?? '' })}
        loading={deleting}
      />
    </div>
  )
}
