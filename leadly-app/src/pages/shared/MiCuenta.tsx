import { useEffect, useState, type FormEvent } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { useLanguage } from '../../contexts/LanguageContext'
import type { TranslationKey } from '../../i18n/translations'
import { changeOwnPassword, updateOwnProfile } from '../../lib/api/users'
import { Badge, Button, Card, CardSection, FieldError, Input, Label } from '../../components/ui'
import { InitialsAvatar } from '../../components/ui'
import { isNotBlank, isValidE164Phone, isValidPassword, PASSWORD_MIN_LENGTH } from '../../lib/validation'

const ROLE_LABEL_KEY: Record<string, TranslationKey> = {
  superadmin: 'account.role.superadmin',
  tenant_admin: 'account.role.tenantAdmin',
  tenant_agent: 'account.role.tenantAgent',
}

export function MiCuenta() {
  const { profile, refreshProfile } = useAuth()
  const { t } = useLanguage()

  return (
    <div className="space-y-4">
      {profile && (
        <Card padded={false} className="max-w-xl">
          <CardSection title={t('account.profile.title')}>
            <div className="mb-4 flex items-center gap-3">
              <InitialsAvatar name={profile.full_name} size="md" />
              <div>
                <p className="text-sm font-semibold text-brand-800">{profile.full_name}</p>
                <Badge tone="neutral">{profile.role in ROLE_LABEL_KEY ? t(ROLE_LABEL_KEY[profile.role]) : profile.role}</Badge>
              </div>
            </div>
            <ProfileForm profileId={profile.id} fullName={profile.full_name} email={profile.email} phone={profile.phone} onSaved={refreshProfile} />
          </CardSection>

          <CardSection title={t('account.password.title')}>
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
  const { t } = useLanguage()
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

  const nameError = touched && !isNotBlank(name) ? t('account.errors.nameRequired') : undefined
  const phoneError = touched && isNotBlank(phoneValue) && !isValidE164Phone(phoneValue) ? t('account.errors.invalidPhone') : undefined

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
      setFormError(err instanceof Error ? err.message : t('account.errors.saveProfileFailed'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-3.5">
      <div>
        <Label htmlFor="account-name">{t('account.field.fullName')}</Label>
        <Input id="account-name" value={name} invalid={!!nameError} onChange={(e) => setName(e.target.value)} />
        <FieldError message={nameError} />
      </div>

      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
        <div>
          <Label htmlFor="account-email">{t('account.field.email')}</Label>
          <Input id="account-email" value={email} disabled />
        </div>

        <div>
          <Label htmlFor="account-phone">{t('account.field.phone')}</Label>
          <Input id="account-phone" value={phoneValue} invalid={!!phoneError} onChange={(e) => setPhoneValue(e.target.value)} placeholder="+573001234567" />
          <FieldError message={phoneError} />
        </div>
      </div>

      {formError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</p>}
      {success && <p className="text-xs text-emerald-600">{t('account.profile.updated')}</p>}

      <Button type="submit" variant="secondary" disabled={submitting} className="!px-4 !py-2 text-sm">
        {submitting ? t('common.actions.saving') : t('common.actions.saveChanges')}
      </Button>
    </form>
  )
}

function PasswordForm() {
  const { t } = useLanguage()
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [touched, setTouched] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  const passwordError = touched && !isValidPassword(newPassword) ? t('account.errors.passwordMinLength', { min: PASSWORD_MIN_LENGTH }) : undefined
  const confirmError = touched && confirmPassword !== newPassword ? t('account.errors.passwordMismatch') : undefined

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
      setFormError(err instanceof Error ? err.message : t('account.errors.changePasswordFailed'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-3.5">
      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
        <div>
          <Label htmlFor="account-new-password">{t('account.field.newPassword')}</Label>
          <Input id="account-new-password" type="password" value={newPassword} invalid={!!passwordError} onChange={(e) => setNewPassword(e.target.value)} />
          <FieldError message={passwordError} />
        </div>

        <div>
          <Label htmlFor="account-confirm-password">{t('account.field.confirmPassword')}</Label>
          <Input id="account-confirm-password" type="password" value={confirmPassword} invalid={!!confirmError} onChange={(e) => setConfirmPassword(e.target.value)} />
          <FieldError message={confirmError} />
        </div>
      </div>

      {formError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</p>}
      {success && <p className="text-xs text-emerald-600">{t('account.password.updated')}</p>}

      <Button type="submit" variant="secondary" disabled={submitting} className="!px-4 !py-2 text-sm">
        {submitting ? t('account.password.updating') : t('account.password.submit')}
      </Button>
    </form>
  )
}
