import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../lib/supabaseClient'
import { AuthSplitLayout } from '../../components/layout/AuthSplitLayout'
import { Button, FieldError, IconInput, Label } from '../../components/ui'
import { MailIcon } from '../../components/icons'
import { isValidEmail, normalizeEmail } from '../../lib/validation'

export function ForgotPassword() {
  const [email, setEmail] = useState('')
  const [touched, setTouched] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [sent, setSent] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const emailError = touched && !isValidEmail(email) ? 'Ingresa un correo válido.' : undefined

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    setFormError(null)
    if (!isValidEmail(email)) return

    setSubmitting(true)
    const { error } = await supabase.auth.resetPasswordForEmail(normalizeEmail(email), {
      redirectTo: `${window.location.origin}/login`,
    })
    setSubmitting(false)
    // Always show the same success state regardless of whether the email exists --
    // returning a different result for "unknown email" would let anyone enumerate
    // which addresses have a Leadly account.
    if (!error) setSent(true)
    else setFormError(error.message)
  }

  return (
    <AuthSplitLayout
      topRight={
        <Link to="/login" className="text-sm font-medium text-accent-600 hover:text-accent-700">
          Volver a iniciar sesión
        </Link>
      }
    >
      <div className="animate-fade-in">
        <h1 className="text-2xl font-extrabold text-brand-800 sm:text-3xl">Recupera tu contraseña</h1>
        <p className="mt-1 text-brand-400">Te enviaremos un enlace para crear una nueva.</p>

        {sent ? (
          <p className="mt-6 rounded-lg bg-accent-50 px-4 py-3 text-sm text-accent-700">
            Si <span className="font-medium">{normalizeEmail(email)}</span> tiene una cuenta en Leadly, te llegará un correo con
            instrucciones en unos minutos.
          </p>
        ) : (
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

            {formError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</p>}

            <Button type="submit" variant="secondary" className="w-full" disabled={submitting}>
              {submitting ? 'Enviando…' : 'Enviar enlace'}
            </Button>
          </form>
        )}
      </div>
    </AuthSplitLayout>
  )
}
