import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { createTenantRole, listRolePermissionKeys, setRolePermissions, updateTenantRole } from '../../../lib/api/permissions'
import type { PermissionAction, TenantRole } from '../../../types/domain'
import { FieldError } from '@/components/atoms'
import { Drawer } from '@/components/organisms'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import { isNotBlank } from '../../../lib/validation'
import { useLanguage } from '../../../contexts/LanguageContext'
import type { TranslationKey } from '../../../i18n/translations'

/** Mismas claves que TENANT_MODULES (lib/modules.ts) -- reutiliza esas
 * etiquetas de nav en vez de duplicar el texto acá. */
const MODULE_LABEL_KEY: Record<string, TranslationKey> = {
  conversations: 'common.nav.conversations',
  contacts: 'common.nav.contacts',
  pipeline: 'common.nav.pipeline',
  products: 'common.nav.products',
  sales: 'common.nav.sales',
  credit: 'common.nav.credit',
  returns: 'common.nav.returns',
  calendar: 'common.nav.calendar',
  tasks: 'common.nav.tasks',
  campaigns: 'common.nav.campaigns',
  aiAgents: 'common.nav.aiAgents',
}

/** Crea o edita un tenant_role -- nombre/descripción + un checklist de
 * permission_actions agrupado por módulo. En edición, precarga los
 * permisos ya otorgados (listRolePermissionKeys) antes de mostrar el
 * checklist, para no arrancar de una lista vacía que borraría todo si el
 * usuario guarda sin tocar nada. */
export function RoleDrawer({
  open,
  onClose,
  tenantId,
  role,
  actions,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  tenantId: string
  /** Presente al editar un rol existente; ausente al crear uno nuevo. */
  role?: TenantRole | null
  actions: PermissionAction[]
  onSaved: (role: TenantRole) => void
}) {
  const { t } = useLanguage()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loadingPermissions, setLoadingPermissions] = useState(false)
  const [touched, setTouched] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setName(role?.name ?? '')
    setDescription(role?.description ?? '')
    setTouched(false)
    setFormError(null)
    if (role) {
      setLoadingPermissions(true)
      listRolePermissionKeys(role.id)
        .then(setSelected)
        .catch(() => setSelected(new Set()))
        .finally(() => setLoadingPermissions(false))
    } else {
      setSelected(new Set())
    }
  }, [open, role])

  const groups = useMemo(() => {
    const byModule = new Map<string, PermissionAction[]>()
    for (const action of actions) {
      const list = byModule.get(action.module_key) ?? []
      list.push(action)
      byModule.set(action.module_key, list)
    }
    return [...byModule.entries()]
  }, [actions])

  const nameError = touched && !isNotBlank(name) ? t('settings.roles.drawer.errors.nameRequired') : undefined

  function toggle(key: string, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (checked) next.add(key)
      else next.delete(key)
      return next
    })
  }

  function toggleModule(moduleActions: PermissionAction[], checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev)
      for (const a of moduleActions) {
        if (checked) next.add(a.key)
        else next.delete(a.key)
      }
      return next
    })
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    setFormError(null)
    if (!isNotBlank(name)) return

    setSubmitting(true)
    try {
      const saved = role ? await updateTenantRole(role.id, name.trim(), description.trim() || null) : await createTenantRole(tenantId, name.trim(), description.trim() || null)
      await setRolePermissions(saved.id, [...selected])
      onSaved(saved)
      onClose()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('settings.roles.drawer.errors.saveFailed'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={role ? t('settings.roles.drawer.editTitle') : t('settings.roles.drawer.newTitle')}
      description={t('settings.roles.drawer.description')}
      size="lg"
    >
      <form onSubmit={handleSubmit} noValidate className="space-y-5">
        <div>
          <Label htmlFor="role-name">{t('settings.roles.drawer.fields.name')}</Label>
          <Input id="role-name" value={name} aria-invalid={!!nameError} onChange={(e) => setName(e.target.value)} className="mt-1" />
          <FieldError message={nameError} />
        </div>
        <div>
          <Label htmlFor="role-description">{t('settings.roles.drawer.fields.description')}</Label>
          <Textarea id="role-description" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} className="mt-1" />
        </div>

        <div>
          <p className="text-[11px] font-semibold tracking-wide text-brand-400 uppercase">{t('settings.roles.drawer.permissionsTitle')}</p>
          {loadingPermissions ? (
            <p className="mt-2 text-xs text-brand-400">{t('common.actions.loading')}</p>
          ) : (
            <div className="mt-2 space-y-4">
              {groups.map(([moduleKey, moduleActions]) => {
                const allChecked = moduleActions.every((a) => selected.has(a.key))
                const someChecked = !allChecked && moduleActions.some((a) => selected.has(a.key))
                return (
                  <div key={moduleKey} className="rounded-xl border border-brand-100 p-3">
                    <label className="flex items-center gap-2 text-xs font-semibold text-brand-700">
                      <Checkbox
                        checked={someChecked ? 'indeterminate' : allChecked}
                        onCheckedChange={(checked) => toggleModule(moduleActions, checked === true)}
                      />
                      {moduleKey in MODULE_LABEL_KEY ? t(MODULE_LABEL_KEY[moduleKey]) : moduleKey}
                    </label>
                    <div className="mt-2 grid grid-cols-1 gap-1.5 pl-6 sm:grid-cols-2">
                      {moduleActions.map((action) => (
                        <label key={action.key} className="flex items-start gap-2 text-xs text-brand-600">
                          <Checkbox checked={selected.has(action.key)} onCheckedChange={(checked) => toggle(action.key, checked === true)} className="mt-0.5" />
                          <span>{action.name}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {formError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</p>}

        <div className="flex gap-2 border-t border-brand-100 pt-4">
          <Button type="submit" disabled={submitting || loadingPermissions}>
            {submitting ? t('common.actions.saving') : t('common.actions.save')}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('common.actions.cancel')}
          </Button>
        </div>
      </form>
    </Drawer>
  )
}
