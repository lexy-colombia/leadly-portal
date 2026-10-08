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
        <span className="flex items-center gap-3 text-xs">
          <span className="hidden text-brand-400 sm:inline">{t('auth.login.noAccount')}</span>
          <Link to="/signup" className="rounded-lg border border-accent-200 px-4 py-2 font-medium text-accent-600 transition-colors hover:bg-accent-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400">
            {t('auth.login.signUp')}
          </Link>
        </span>
      }
    >
      <div className="animate-fade-in">
        <div aria-hidden="true" className="mb-6 h-1 w-10 rounded-full bg-accent-500" />
        <h1 className="text-3xl leading-tight font-extrabold tracking-tight text-brand-800 sm:text-4xl">{t('auth.login.title')}</h1>
        <p className="mt-3 text-sm leading-relaxed text-brand-400">{t('auth.login.subtitle')}</p>

        <form onSubmit={handleSubmit} noValidate className="mt-8 flex flex-col gap-5">
          <div>
            <Label htmlFor="email">{t('auth.email')}</Label>
            <IconInput
              id="email"
              className="h-12"
              aria-invalid={!!emailError}
              aria-describedby={emailError ? "login-email-error" : undefined}
              type="email"
              autoComplete="email"
              icon={<MailIcon />}
              value={email}
              invalid={!!emailError}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="tu@empresa.com"
            />
            <div id="login-email-error"><FieldError message={emailError} /></div>
          </div>

          <div>
            <div className="flex items-center justify-between">
              <Label htmlFor="password">{t('auth.password')}</Label>
              <Link to="/forgot-password" className="mb-1 text-xs font-medium text-accent-600 hover:text-accent-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400">
                {t('auth.login.forgotPassword')}
              </Link>
            </div>
            <PasswordInput
              id="password"
              className="h-12"
              aria-invalid={!!passwordError}
              aria-describedby={passwordError ? "login-password-error" : undefined}
              autoComplete="current-password"
              icon={<LockIcon />}
              value={password}
              invalid={!!passwordError}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••••••"
            />
            <div id="login-password-error"><FieldError message={passwordError} /></div>
          </div>

          {formError && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{formError}</p>}

          <Button type="submit" variant="secondary" className="mt-1 h-12 w-full" disabled={submitting}>
            {submitting ? t('auth.login.submitting') : t('auth.login.submit')}
          </Button>
        </form>

        <div className="my-6 flex items-center gap-3 text-xs text-brand-300">
          <div className="h-px flex-1 bg-brand-100" />
          {t('auth.orContinueWith')}
          <div className="h-px flex-1 bg-brand-100" />
        </div>

        <Button type="button" variant="ghost" className="h-12 w-full" onClick={handleGoogle}>
          <GoogleIcon /> {t('auth.continueWithGoogle')}
        </Button>

        <div className="mt-8">
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
