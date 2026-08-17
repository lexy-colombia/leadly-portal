import { useState, type FormEvent } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { useLanguage } from '../../contexts/LanguageContext'
import { AuthSplitLayout } from '@/components/organisms'
import { AuroraCallout } from '@/components/molecules'
import { Button, FieldError, Label } from '@/components/atoms'
import { IconInput, PasswordInput } from '@/components/molecules'
import { GoogleIcon, LockIcon, MailIcon } from '@/components/atoms/icons'
import { isValidEmail, isNotBlank, normalizeEmail } from '../../lib/validation'

export function Login() {
  const { session, loading, signInWithPassword, signInWithGoogle } = useAuth()
  const { t } = useLanguage()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [touched, setTouched] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  if (!loading && session) {
    return <Navigate to="/" replace />
  }

  const emailError = touched && !isValidEmail(email) ? t('auth.errors.invalidEmail') : undefined
  const passwordError = touched && !isNotBlank(password) ? t('auth.errors.passwordRequired') : undefined

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    setFormError(null)
    if (!isValidEmail(email) || !isNotBlank(password)) return

    setSubmitting(true)
    const { error } = await signInWithPassword(normalizeEmail(email), password)
    setSubmitting(false)
    if (error) {
      setFormError(error.toLowerCase().includes('invalid login credentials') ? t('auth.errors.invalidCredentials') : error)
    }
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
          <span className="hidden text-brand-400 sm:inline">{t('auth.login.noAccount')}</span>
          <Link to="/signup" className="rounded-lg border border-accent-200 px-3 py-1.5 font-medium text-accent-600 hover:bg-accent-50">
            {t('auth.login.signUp')}
          </Link>
        </span>
      }
    >
      <div className="animate-fade-in">
        <h1 className="text-2xl font-extrabold text-brand-800 sm:text-3xl">{t('auth.login.title')}</h1>
        <p className="mt-1 text-brand-400">{t('auth.login.subtitle')}</p>

        <form onSubmit={handleSubmit} noValidate className="mt-6 space-y-4">
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
            <div className="flex items-center justify-between">
              <Label htmlFor="password">{t('auth.password')}</Label>
              <Link to="/forgot-password" className="mb-1 text-xs font-medium text-accent-600 hover:text-accent-700">
                {t('auth.login.forgotPassword')}
              </Link>
            </div>
            <PasswordInput
              id="password"
              autoComplete="current-password"
              icon={<LockIcon />}
              value={password}
              invalid={!!passwordError}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••••••"
            />
            <FieldError message={passwordError} />
          </div>

          {formError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</p>}

          <Button type="submit" variant="secondary" className="w-full" disabled={submitting}>
            {submitting ? t('auth.login.submitting') : t('auth.login.submit')}
          </Button>
        </form>

        <div className="my-5 flex items-center gap-3 text-xs text-brand-300">
          <div className="h-px flex-1 bg-brand-100" />
          {t('auth.orContinueWith')}
          <div className="h-px flex-1 bg-brand-100" />
        </div>

        <Button type="button" variant="ghost" className="w-full" onClick={handleGoogle}>
          <GoogleIcon /> {t('auth.continueWithGoogle')}
        </Button>

        <div className="mt-6">
          <AuroraCallout
            message={
              <>
                <span className="font-semibold">Aurora</span>, {t('auth.auroraCallout')}
              </>
            }
          />
        </div>
      </div>
    </AuthSplitLayout>
  )
}
