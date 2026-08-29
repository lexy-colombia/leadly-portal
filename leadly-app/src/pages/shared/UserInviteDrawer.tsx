import { useEffect, useState, type FormEvent } from 'react'
import { inviteTenantUser } from '../../lib/api/users'
import { listTenantRoles } from '../../lib/api/permissions'
import type { Profile, TenantRole } from '../../types/domain'
import { useLanguage } from '../../contexts/LanguageContext'
import { FieldError } from '@/components/atoms'
import { Drawer } from '@/components/organisms'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { isNotBlank, isValidE164Phone, isValidEmail } from '../../lib/validation'

/** Un solo select de "Rol" -- no dos (pedido explícito del usuario: pedir
 * el rol dos veces, uno de plataforma y otro de tenant_role, se sentía
 * como un error). ADMIN_VALUE es el único valor que no es un uuid real de
 * tenant_roles, así que no puede colisionar. */
const ADMIN_VALUE = 'admin'

/** Shared by the backoffice (from a Cliente's "Usuarios" section) and the
 * tenant panel (from "Usuarios", tenant_admin only) -- tenantId is always
 * fixed/implicit from the caller, this never exposes a tenant selector or
 * the superadmin role (that stays a rare, SQL-driven bootstrap action). */
export function UserInviteDrawer({
  open,
  onClose,
  tenantId,
  onInvited,
}: {
  open: boolean
  onClose: () => void
  tenantId: string
  onInvited: (profile: Profile) => void
}) {
  const { t } = useLanguage()
  const [email, setEmail] = useState('')
  const [fullName, setFullName] = useState('')
  const [phone, setPhone] = useState('')
  const [tenantRoles, setTenantRoles] = useState<TenantRole[]>([])
  /** ADMIN_VALUE o el id de un tenant_role. */
  const [selectedRole, setSelectedRole] = useState<string>('')
  const [touched, setTouched] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  useEffect(() => {
    if (!open) return
    setEmail('')
    setFullName('')
    setPhone('')
    setSelectedRole('')
    setTouched(false)
    setFormError(null)
    setSuccess(false)
  }, [open])

  useEffect(() => {
    if (!open) return
    listTenantRoles(tenantId)
      .then((roles) => {
        setTenantRoles(roles)
        setSelectedRole((prev) => prev || roles[0]?.id || ADMIN_VALUE)
      })
      .catch(() => {})
  }, [open, tenantId])

  const emailError = touched && !isValidEmail(email) ? t('auth.errors.invalidEmail') : undefined
  const fullNameError = touched && !isNotBlank(fullName) ? t('auth.errors.nameRequired') : undefined
  const phoneError = touched && isNotBlank(phone) && !isValidE164Phone(phone) ? t('inbox.newConv.errors.invalidPhone') : undefined
  const roleError = touched && !selectedRole ? t('account.invite.errors.tenantRoleRequired') : undefined

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    setFormError(null)
    if (!isValidEmail(email) || !isNotBlank(fullName) || (isNotBlank(phone) && !isValidE164Phone(phone)) || !selectedRole) return

    setSubmitting(true)
    try {
      const isAdmin = selectedRole === ADMIN_VALUE
      const profile = await inviteTenantUser({
        email: email.trim(),
        full_name: fullName.trim(),
        phone: phone.trim() || null,
        role: isAdmin ? 'tenant_admin' : 'tenant_agent',
        tenant_id: tenantId,
        tenant_role_id: isAdmin ? null : selectedRole,
      })
      onInvited(profile)
      setSuccess(true)
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('account.invite.errors.failed'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Drawer open={open} onClose={onClose} title={t('account.invite.title')} description={t('account.invite.description')}>
      {success ? (
        <div className="space-y-4">
          <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
            {t('account.invite.sentPrefix')} <span className="font-medium">{email}</span>.
          </p>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('common.actions.close')}
          </Button>
        </div>
      ) : (
        <form onSubmit={handleSubmit} noValidate className="space-y-4">
          <div>
            <Label htmlFor="invite-full-name">{t('auth.signup.yourName')}</Label>
            <Input
              id="invite-full-name"
              value={fullName}
              aria-invalid={!!fullNameError}
              onChange={(e) => setFullName(e.target.value)}
              placeholder={t('auth.namePlaceholder')}
            />
            <FieldError message={fullNameError} />
          </div>

          <div>
            <Label htmlFor="invite-email">{t('account.field.email')}</Label>
            <Input
              id="invite-email"
              type="email"
              value={email}
              aria-invalid={!!emailError}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="persona@empresa.com"
            />
            <FieldError message={emailError} />
          </div>

          <div>
            <Label htmlFor="invite-phone">{t('account.invite.phoneOptional')}</Label>
            <Input
              id="invite-phone"
              value={phone}
              aria-invalid={!!phoneError}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+573001234567"
            />
            <FieldError message={phoneError} />
          </div>

          <div>
            <Label htmlFor="invite-role">{t('account.invite.role')}</Label>
            <Select value={selectedRole} onValueChange={setSelectedRole}>
              <SelectTrigger id="invite-role" aria-invalid={!!roleError} className="mt-1 w-full">
                <SelectValue placeholder={t('account.invite.tenantRolePlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ADMIN_VALUE}>{t('account.role.tenantAdmin')}</SelectItem>
                {tenantRoles.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldError message={roleError} />
          </div>

          {formError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</p>}

          <div className="flex gap-2 border-t border-brand-100 pt-5">
            <Button type="submit" variant="secondary" disabled={submitting}>
              {submitting ? t('account.invite.submitting') : t('account.invite.submit')}
            </Button>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
          </div>
        </form>
      )}
    </Drawer>
  )
}
