import { useState, type FormEvent } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { AuthSplitLayout } from '../../components/layout/AuthSplitLayout'
import { AuroraCallout } from '../../components/brand/AuroraCallout'
import { Button, FieldError, IconInput, Label, PasswordInput } from '../../components/ui'
import { GoogleIcon, LockIcon, MailIcon } from '../../components/icons'
import { isValidEmail, isNotBlank, normalizeEmail } from '../../lib/validation'

export function Login() {
  const { session, loading, signInWithPassword, signInWithGoogle } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [touched, setTouched] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  if (!loading && session) {
    return <Navigate to="/" replace />
  }

  const emailError = touched && !isValidEmail(email) ? 'Ingresa un correo válido.' : undefined
  const passwordError = touched && !isNotBlank(password) ? 'La contraseña es obligatoria.' : undefined

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    setFormError(null)
    if (!isValidEmail(email) || !isNotBlank(password)) return

    setSubmitting(true)
    const { error } = await signInWithPassword(normalizeEmail(email), password)
    setSubmitting(false)
    if (error) {
      setFormError(
        error.toLowerCase().includes('invalid login credentials') ? 'Correo o contraseña incorrectos.' : error,
      )
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
          <span className="hidden text-brand-400 sm:inline">¿No tienes cuenta?</span>
          <Link to="/signup" className="rounded-lg border border-accent-200 px-3 py-1.5 font-medium text-accent-600 hover:bg-accent-50">
            Regístrate
          </Link>
        </span>
      }
    >
      <div className="animate-fade-in">
        <h1 className="text-2xl font-extrabold text-brand-800 sm:text-3xl">¡Bienvenido de nuevo!</h1>
        <p className="mt-1 text-brand-400">Inicia sesión y sigue impulsando tus ventas.</p>

        <form onSubmit={handleSubmit} noValidate className="mt-6 space-y-4">
          <div>
            <Label htmlFor="email">Correo electrónico</Label>
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
              <Label htmlFor="password">Contraseña</Label>
              <Link to="/forgot-password" className="mb-1 text-xs font-medium text-accent-600 hover:text-accent-700">
                ¿Olvidaste tu contraseña?
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
            {submitting ? 'Ingresando…' : 'Iniciar sesión'}
          </Button>
        </form>

        <div className="my-5 flex items-center gap-3 text-xs text-brand-300">
          <div className="h-px flex-1 bg-brand-100" />o continúa con
          <div className="h-px flex-1 bg-brand-100" />
        </div>

        <Button type="button" variant="ghost" className="w-full" onClick={handleGoogle}>
          <GoogleIcon /> Continuar con Google
        </Button>

        <div className="mt-6">
          <AuroraCallout
            message={
              <>
                <span className="font-semibold">Aurora</span>, la IA de <span className="font-semibold">Leadly</span>, está lista para
                ayudarte a cerrar más ventas, todos los días.
              </>
            }
          />
        </div>
      </div>
    </AuthSplitLayout>
  )
}
