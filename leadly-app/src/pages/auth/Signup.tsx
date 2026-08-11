import { useState, type FormEvent } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { useLanguage } from '../../contexts/LanguageContext'
import { AuthSplitLayout } from '../../components/layout/AuthSplitLayout'
import { Button, FieldError, IconInput, Input, Label, PasswordInput } from '../../components/ui'
import { GoogleIcon, LockIcon, MailIcon } from '../../components/icons'
import { isNotBlank, isValidEmail, isValidPassword, normalizeEmail, PASSWORD_MIN_LENGTH } from '../../lib/validation'

export function Signup() {
  const { session, loading, signUpWithPassword, signInWithGoogle } = useAuth()
  const { t } = useLanguage()
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [touched, setTouched] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [confirmationSent, setConfirmationSent] = useState(false)

  if (!loading && session) {
    return <Navigate to="/" replace />
  }

  const fullNameError = touched && !isNotBlank(fullName) ? t('auth.errors.nameRequired') : undefined
  const emailError = touched && !isValidEmail(email) ? t('auth.errors.invalidEmail') : undefined
  const passwordError =
    touched && !isValidPassword(password) ? t('auth.errors.passwordMinLength', { min: PASSWORD_MIN_LENGTH }) : undefined

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    setFormError(null)
    if (!isNotBlank(fullName) || !isValidEmail(email) || !isValidPassword(password)) return

    setSubmitting(true)
    const { error, needsEmailConfirmation } = await signUpWithPassword(normalizeEmail(email), password, fullName.trim())
    setSubmitting(false)
    if (error) {
      setFormError(error.toLowerCase().includes('already registered') ? t('auth.errors.emailAlreadyRegistered') : error)
      return
    }
    if (needsEmailConfirmation) setConfirmationSent(true)
  }

  async function handleGoogle() {
    setFormError(null)
    const { error } = await signInWithGoogle()
    if (error) setFormError(error)
  }

  return (
    <AuthSplitLayout
      topRight={
        <span className="flex items-center gap-3 text-sm">
          <span className="hidden text-brand-400 sm:inline">{t('auth.signup.hasAccount')}</span>
          <Link to="/login" className="rounded-lg border border-accent-200 px-3 py-1.5 font-medium text-accent-600 hover:bg-accent-50">
            {t('auth.signup.signIn')}
          </Link>
        </span>
      }
    >
      <div className="animate-fade-in">
        <h1 className="text-2xl font-extrabold text-brand-800 sm:text-3xl">{t('auth.signup.title')}</h1>
        <p className="mt-1 text-brand-400">{t('auth.signup.subtitle')}</p>

        {confirmationSent ? (
          <p className="mt-6 rounded-lg bg-accent-50 px-4 py-3 text-sm text-accent-700">
            {t('auth.signup.confirmationSent.prefix')} <span className="font-medium">{normalizeEmail(email)}</span>{' '}
            {t('auth.signup.confirmationSent.suffix')}
          </p>
        ) : (
          <>
            <form onSubmit={handleSubmit} noValidate className="mt-6 space-y-4">
              <div>
                <Label htmlFor="fullName">{t('auth.signup.yourName')}</Label>
                <Input
                  id="fullName"
                  autoComplete="name"
                  value={fullName}
                  invalid={!!fullNameError}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder={t('auth.namePlaceholder')}
                />
                <FieldError message={fullNameError} />
              </div>

              <div>
                <Label htmlFor="email">{t('auth.email')}</Label>
                <IconInput
                  id="email"
                  type="email"
                  autoComplete="email"
                  icon={<MailIcon />}
                  value={email}
                  invalid={!!emailError}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="tu@empresa.com"
                />
                <FieldError message={emailError} />
              </div>

              <div>
                <Label htmlFor="password">{t('auth.password')}</Label>
                <PasswordInput
                  id="password"
                  autoComplete="new-password"
                  icon={<LockIcon />}
                  value={password}
                  invalid={!!passwordError}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={t('auth.signup.passwordPlaceholder')}
                />
                <FieldError message={passwordError} />
              </div>

              {formError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</p>}

              <Button type="submit" variant="secondary" className="w-full" disabled={submitting}>
                {submitting ? t('auth.signup.submitting') : t('auth.signup.submit')}
              </Button>
            </form>

            <div className="my-5 flex items-center gap-3 text-xs text-brand-300">
              <div className="h-px flex-1 bg-brand-100" />
              {t('auth.orContinueWith')}
              <div className="h-px flex-1 bg-brand-100" />
            </div>

            <Button type="button" variant="ghost" className="w-full" onClick={handleGoogle}>
              <GoogleIcon /> {t('auth.signup.continueWithGoogle')}
            </Button>

            <p className="mt-6 text-center text-xs text-brand-300">{t('auth.signup.disclaimer')}</p>
          </>
        )}
      </div>
    </AuthSplitLayout>
  )
}
