import { useEffect, useState, type FormEvent } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { changeOwnPassword, updateOwnProfile } from '../../lib/api/users'
import { Badge, Button, Card, CardSection, FieldError, Input, Label } from '../../components/ui'
import { InitialsAvatar } from '../../components/ui'
import { isNotBlank, isValidE164Phone, isValidPassword, PASSWORD_MIN_LENGTH } from '../../lib/validation'

const ROLE_LABEL: Record<string, string> = {
  superadmin: 'Superadmin',
  tenant_admin: 'Administrador',
  tenant_agent: 'Agente',
}

export function MiCuenta() {
  const { profile, refreshProfile } = useAuth()

  return (
    <div className="space-y-4">
      {profile && (
        <Card padded={false} className="max-w-xl">
          <CardSection title="Perfil">
            <div className="mb-4 flex items-center gap-3">
              <InitialsAvatar name={profile.full_name} size="md" />
              <div>
                <p className="text-sm font-semibold text-brand-800">{profile.full_name}</p>
                <Badge tone="neutral">{ROLE_LABEL[profile.role] ?? profile.role}</Badge>
              </div>
            </div>
            <ProfileForm profileId={profile.id} fullName={profile.full_name} email={profile.email} phone={profile.phone} onSaved={refreshProfile} />
          </CardSection>

          <CardSection title="Contraseña">
            <PasswordForm />
          </CardSection>
        </Card>
      )}
    </div>
  )
}

function ProfileForm({
  profileId,
  fullName,
  email,
  phone,
  onSaved,
}: {
  profileId: string
  fullName: string
  email: string
  phone: string | null
  onSaved: () => void
}) {
  const [name, setName] = useState(fullName)
  const [phoneValue, setPhoneValue] = useState(phone ?? '')
  const [touched, setTouched] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  useEffect(() => {
    setName(fullName)
    setPhoneValue(phone ?? '')
  }, [fullName, phone])

  const nameError = touched && !isNotBlank(name) ? 'El nombre es obligatorio.' : undefined
  const phoneError = touched && isNotBlank(phoneValue) && !isValidE164Phone(phoneValue) ? 'Teléfono inválido (formato internacional).' : undefined

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    setFormError(null)
    setSuccess(false)
    if (!isNotBlank(name) || (isNotBlank(phoneValue) && !isValidE164Phone(phoneValue))) return

    setSubmitting(true)
    try {
      await updateOwnProfile(profileId, { full_name: name.trim(), phone: phoneValue.trim() || null })
      onSaved()
      setSuccess(true)
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'No se pudo guardar el perfil.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-3.5">
      <div>
        <Label htmlFor="account-name">Nombre completo</Label>
        <Input id="account-name" value={name} invalid={!!nameError} onChange={(e) => setName(e.target.value)} />
        <FieldError message={nameError} />
      </div>

      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
        <div>
          <Label htmlFor="account-email">Correo</Label>
          <Input id="account-email" value={email} disabled />
        </div>

        <div>
          <Label htmlFor="account-phone">Teléfono</Label>
          <Input id="account-phone" value={phoneValue} invalid={!!phoneError} onChange={(e) => setPhoneValue(e.target.value)} placeholder="+573001234567" />
          <FieldError message={phoneError} />
        </div>
      </div>

      {formError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</p>}
      {success && <p className="text-xs text-emerald-600">Perfil actualizado.</p>}

      <Button type="submit" variant="secondary" disabled={submitting} className="!px-4 !py-2 text-sm">
        {submitting ? 'Guardando…' : 'Guardar cambios'}
      </Button>
    </form>
  )
}

function PasswordForm() {
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [touched, setTouched] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  const passwordError = touched && !isValidPassword(newPassword) ? `Mínimo ${PASSWORD_MIN_LENGTH} caracteres.` : undefined
  const confirmError = touched && confirmPassword !== newPassword ? 'Las contraseñas no coinciden.' : undefined

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    setFormError(null)
    setSuccess(false)
    if (!isValidPassword(newPassword) || confirmPassword !== newPassword) return

    setSubmitting(true)
    try {
      await changeOwnPassword(newPassword)
      setNewPassword('')
      setConfirmPassword('')
      setTouched(false)
      setSuccess(true)
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'No se pudo cambiar la contraseña.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-3.5">
      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
        <div>
          <Label htmlFor="account-new-password">Nueva contraseña</Label>
          <Input id="account-new-password" type="password" value={newPassword} invalid={!!passwordError} onChange={(e) => setNewPassword(e.target.value)} />
          <FieldError message={passwordError} />
        </div>

        <div>
          <Label htmlFor="account-confirm-password">Confirmar contraseña</Label>
          <Input id="account-confirm-password" type="password" value={confirmPassword} invalid={!!confirmError} onChange={(e) => setConfirmPassword(e.target.value)} />
          <FieldError message={confirmError} />
        </div>
      </div>

      {formError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</p>}
      {success && <p className="text-xs text-emerald-600">Contraseña actualizada.</p>}

      <Button type="submit" variant="secondary" disabled={submitting} className="!px-4 !py-2 text-sm">
        {submitting ? 'Actualizando…' : 'Cambiar contraseña'}
      </Button>
    </form>
  )
}
