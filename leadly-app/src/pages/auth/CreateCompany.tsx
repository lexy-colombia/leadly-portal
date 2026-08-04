import { useState, type FormEvent } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { supabase } from '../../lib/supabaseClient'
import { AuthSplitLayout } from '../../components/layout/AuthSplitLayout'
import { Button, FieldError, Input, Label } from '../../components/ui'
import { isNotBlank } from '../../lib/validation'
import { roleHome } from '../../routes/guards'

/** Lands here right after a brand-new signup (Google or email/password) that
 * has no tenant yet -- see RequireAuth/RootRedirect. Two ways out: create a
 * company (self_register_tenant RPC, becomes its tenant_admin) or bail out
 * entirely (self-delete-account Edge Function) to wait for a real invite. */
export function CreateCompany() {
  const { session, loading, unprovisioned, user, refreshProfile, signOut } = useAuth()
  const navigate = useNavigate()

  const metadataName = (user?.user_metadata?.full_name as string | undefined) ?? (user?.user_metadata?.name as string | undefined) ?? ''

  const [tenantName, setTenantName] = useState('')
  const [fullName, setFullName] = useState(metadataName)
  const [touched, setTouched] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  if (!loading && session && !unprovisioned) {
    return <Navigate to="/" replace />
  }
  if (!loading && !session) {
    return <Navigate to="/login" replace />
  }

  const tenantNameError = touched && !isNotBlank(tenantName) ? 'Ingresa el nombre de tu empresa.' : undefined
  const fullNameError = touched && !isNotBlank(fullName) ? 'Ingresa tu nombre.' : undefined

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    setFormError(null)
    if (!isNotBlank(tenantName) || !isNotBlank(fullName)) return

    setSubmitting(true)
    const { error } = await supabase.rpc('self_register_tenant', {
      p_tenant_name: tenantName.trim(),
      p_full_name: fullName.trim(),
    })
    setSubmitting(false)

    if (error) {
      setFormError(error.message)
      return
    }

    await refreshProfile()
    navigate(roleHome('tenant_admin'), { replace: true })
  }

  async function handleDelete() {
    setDeleting(true)
    setDeleteError(null)
    const { error } = await supabase.functions.invoke('self-delete-account', { method: 'POST' })
    setDeleting(false)

    if (error) {
      setDeleteError('No pudimos eliminar tu cuenta. Intenta de nuevo o escríbenos.')
      return
    }
    await signOut()
    navigate('/login', { replace: true })
  }

  return (
    <AuthSplitLayout>
      <div className="animate-fade-in">
        <h1 className="text-2xl font-extrabold text-brand-800 sm:text-3xl">Crea tu empresa</h1>
        <p className="mt-1 text-brand-400">
          Estás a un paso de usar Leadly. Cuéntanos el nombre de tu empresa para configurar tu panel.
        </p>

        <form onSubmit={handleSubmit} noValidate className="mt-6 space-y-4">
          <div>
            <Label htmlFor="tenantName">Nombre de tu empresa</Label>
            <Input
              id="tenantName"
              value={tenantName}
              invalid={!!tenantNameError}
              onChange={(e) => setTenantName(e.target.value)}
              placeholder="Ej. Panadería Los Andes"
            />
            <FieldError message={tenantNameError} />
          </div>

          <div>
            <Label htmlFor="fullName">Tu nombre</Label>
            <Input
              id="fullName"
              value={fullName}
              invalid={!!fullNameError}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="Nombre y apellido"
            />
            <FieldError message={fullNameError} />
          </div>

          {formError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</p>}

          <Button type="submit" variant="secondary" className="w-full" disabled={submitting}>
            {submitting ? 'Creando tu empresa…' : 'Crear mi empresa'}
          </Button>
        </form>

        <div className="mt-8 rounded-xl border border-brand-100 bg-brand-50/50 p-4">
          <p className="text-sm text-brand-500">
            ¿Entraste por error? Si en realidad esperas que alguien te invite a una empresa ya existente en Leadly, puedes eliminar esta
            cuenta y volver a intentarlo cuando tengas la invitación.
          </p>

          {deleteError && <p className="mt-2 text-xs text-red-600">{deleteError}</p>}

          {confirmingDelete ? (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button type="button" variant="danger" onClick={handleDelete} disabled={deleting}>
                {deleting ? 'Eliminando…' : 'Sí, eliminar mi cuenta'}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setConfirmingDelete(false)} disabled={deleting}>
                Cancelar
              </Button>
            </div>
          ) : (
            <Button type="button" variant="ghost" className="mt-3" onClick={() => setConfirmingDelete(true)}>
              No fue mi intención, eliminar mi cuenta
            </Button>
          )}
        </div>
      </div>
    </AuthSplitLayout>
  )
}
