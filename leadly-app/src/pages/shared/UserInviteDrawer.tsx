import { useEffect, useState, type FormEvent } from 'react'
import { inviteTenantUser } from '../../lib/api/users'
import type { Profile } from '../../types/domain'
import { Button, Drawer, FieldError, Input, Label, Select } from '../../components/ui'
import { isNotBlank, isValidE164Phone, isValidEmail } from '../../lib/validation'

const ROLE_LABEL: Record<'tenant_admin' | 'tenant_agent', string> = {
  tenant_admin: 'Administrador',
  tenant_agent: 'Agente',
}

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
  const [email, setEmail] = useState('')
  const [fullName, setFullName] = useState('')
  const [phone, setPhone] = useState('')
  const [role, setRole] = useState<'tenant_admin' | 'tenant_agent'>('tenant_agent')
  const [touched, setTouched] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  useEffect(() => {
    if (!open) return
    setEmail('')
    setFullName('')
    setPhone('')
    setRole('tenant_agent')
    setTouched(false)
    setFormError(null)
    setSuccess(false)
  }, [open])

  const emailError = touched && !isValidEmail(email) ? 'Ingresa un correo válido.' : undefined
  const fullNameError = touched && !isNotBlank(fullName) ? 'El nombre es obligatorio.' : undefined
  const phoneError = touched && isNotBlank(phone) && !isValidE164Phone(phone) ? 'Teléfono inválido (formato internacional).' : undefined

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    setFormError(null)
    if (!isValidEmail(email) || !isNotBlank(fullName) || (isNotBlank(phone) && !isValidE164Phone(phone))) return

    setSubmitting(true)
    try {
      const profile = await inviteTenantUser({
        email: email.trim(),
        full_name: fullName.trim(),
        phone: phone.trim() || null,
        role,
        tenant_id: tenantId,
      })
      onInvited(profile)
      setSuccess(true)
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'No se pudo invitar al usuario.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Drawer open={open} onClose={onClose} title="Invitar usuario" description="Le llegará un correo para crear su contraseña.">
      {success ? (
        <div className="space-y-4">
          <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
            Invitación enviada a <span className="font-medium">{email}</span>.
          </p>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cerrar
          </Button>
        </div>
      ) : (
        <form onSubmit={handleSubmit} noValidate className="space-y-4">
          <div>
            <Label htmlFor="invite-full-name">Nombre completo</Label>
            <Input
              id="invite-full-name"
              value={fullName}
              invalid={!!fullNameError}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="Nombre y apellido"
            />
            <FieldError message={fullNameError} />
          </div>

          <div>
            <Label htmlFor="invite-email">Correo</Label>
            <Input
              id="invite-email"
              type="email"
              value={email}
              invalid={!!emailError}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="persona@empresa.com"
            />
            <FieldError message={emailError} />
          </div>

          <div>
            <Label htmlFor="invite-phone">Teléfono (opcional)</Label>
            <Input
              id="invite-phone"
              value={phone}
              invalid={!!phoneError}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+573001234567"
            />
            <FieldError message={phoneError} />
          </div>

          <div>
            <Label htmlFor="invite-role">Rol</Label>
            <Select id="invite-role" value={role} onChange={(e) => setRole(e.target.value as typeof role)}>
              {(['tenant_admin', 'tenant_agent'] as const).map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </Select>
          </div>

          {formError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</p>}

          <div className="flex gap-2 border-t border-brand-100 pt-5">
            <Button type="submit" variant="secondary" disabled={submitting}>
              {submitting ? 'Invitando…' : 'Enviar invitación'}
            </Button>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancelar
            </Button>
          </div>
        </form>
      )}
    </Drawer>
  )
}
