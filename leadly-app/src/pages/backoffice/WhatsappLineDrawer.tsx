import { useEffect, useState, type FormEvent } from 'react'
import {
  createWhatsappLine,
  setWhatsappLineAccessToken,
  setWhatsappLineStatus,
  updateWhatsappLine,
  whatsappLineHasAccessToken,
  type WhatsappLineInput,
} from '../../lib/api/whatsappLines'
import type { WhatsappLine, WhatsappLineStatus } from '../../types/domain'
import { Button, Drawer, FieldError, Input, Label, Select } from '../../components/ui'
import { useWhatsappLineForm } from './useWhatsappLineForm'
import { WhatsappLineFormFields } from './WhatsappLineFormFields'
import { isNotBlank } from '../../lib/validation'

const STATUS_LABEL: Record<WhatsappLineStatus, string> = {
  pending_verification: 'Pendiente de verificación',
  active: 'Activa',
  suspended: 'Suspendida',
  disconnected: 'Desconectada',
}

/** One drawer for both "nueva línea" and "editar línea" -- always scoped to a
 * single tenant (the tenant select from the old standalone page is gone; a
 * line only ever gets created from inside its owning Cliente's page now). */
export function WhatsappLineDrawer({
  open,
  onClose,
  tenantId,
  line,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  tenantId: string
  line?: WhatsappLine | null
  onSaved: (line: WhatsappLine) => void
}) {
  const isEdit = !!line
  const form = useWhatsappLineForm({ tenant_id: tenantId, ...line })
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const [status, setStatus] = useState<WhatsappLineStatus>(line?.status ?? 'pending_verification')
  const [statusSaving, setStatusSaving] = useState(false)

  const [hasToken, setHasToken] = useState<boolean | null>(null)
  const [tokenValue, setTokenValue] = useState('')
  const [tokenTouched, setTokenTouched] = useState(false)
  const [tokenSaving, setTokenSaving] = useState(false)
  const [tokenError, setTokenError] = useState<string | null>(null)
  const [tokenSaved, setTokenSaved] = useState(false)

  useEffect(() => {
    if (!open) return
    form.setTouched(false)
    setFormError(null)
    setTokenValue('')
    setTokenTouched(false)
    setTokenSaved(false)
    setTokenError(null)
    setStatus(line?.status ?? 'pending_verification')
    if (line) {
      whatsappLineHasAccessToken(line.id)
        .then(setHasToken)
        .catch(() => setHasToken(null))
    } else {
      setHasToken(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, line?.id])

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    form.setTouched(true)
    setFormError(null)
    if (!form.isValid()) return
    if (!isEdit && !isNotBlank(tokenValue)) {
      setTokenTouched(true)
      return
    }

    setSubmitting(true)
    try {
      const input: WhatsappLineInput = form.toInput()
      if (isEdit && line) {
        const updated = await updateWhatsappLine(line.id, input)
        onSaved(updated)
      } else {
        const created = await createWhatsappLine(input)
        await setWhatsappLineAccessToken(created.id, tokenValue.trim())
        onSaved(created)
      }
      onClose()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'No se pudo guardar la línea.')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleStatusChange(next: WhatsappLineStatus) {
    if (!line) return
    setStatus(next)
    setStatusSaving(true)
    try {
      const updated = await setWhatsappLineStatus(line.id, next)
      onSaved(updated)
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'No se pudo actualizar el estado.')
      setStatus(line.status)
    } finally {
      setStatusSaving(false)
    }
  }

  async function handleTokenSave() {
    if (!line) return
    setTokenTouched(true)
    setTokenError(null)
    setTokenSaved(false)
    if (!isNotBlank(tokenValue)) return

    setTokenSaving(true)
    try {
      await setWhatsappLineAccessToken(line.id, tokenValue.trim())
      setHasToken(true)
      setTokenValue('')
      setTokenTouched(false)
      setTokenSaved(true)
    } catch (err) {
      setTokenError(err instanceof Error ? err.message : 'No se pudo guardar el access token.')
    } finally {
      setTokenSaving(false)
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={isEdit ? 'Editar línea de WhatsApp' : 'Nueva línea de WhatsApp'}
      description={isEdit ? line?.display_name : 'Se asigna automáticamente a este cliente.'}
      footer={
        <div className="flex gap-2">
          <Button type="submit" form="whatsapp-line-form" variant="secondary" disabled={submitting}>
            {submitting ? 'Guardando…' : isEdit ? 'Guardar cambios' : 'Crear línea'}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
        </div>
      }
    >
      <div className="space-y-6">
        {isEdit && line && (
          <div>
            <Label htmlFor="line-status">Estado de verificación</Label>
            <Select
              id="line-status"
              value={status}
              disabled={statusSaving}
              onChange={(e) => handleStatusChange(e.target.value as WhatsappLineStatus)}
            >
              {Object.entries(STATUS_LABEL).map(([value, statusLabel]) => (
                <option key={value} value={value}>
                  {statusLabel}
                </option>
              ))}
            </Select>
          </div>
        )}

        <form id="whatsapp-line-form" onSubmit={handleSubmit} noValidate className="space-y-4">
          <WhatsappLineFormFields form={form} />

          {!isEdit && (
            <div>
              <Label htmlFor="line-token">Access token de Meta</Label>
              <Input
                id="line-token"
                type="password"
                value={tokenValue}
                invalid={tokenTouched && !isNotBlank(tokenValue)}
                onChange={(e) => setTokenValue(e.target.value)}
                placeholder="EAAG..."
                autoComplete="off"
              />
              <FieldError message={tokenTouched && !isNotBlank(tokenValue) ? 'El access token es obligatorio.' : undefined} />
              <p className="mt-1 text-xs text-brand-400">Se guarda cifrado (Supabase Vault); nunca se vuelve a mostrar.</p>
            </div>
          )}

          {formError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</p>}
        </form>

        {isEdit && (
          <div className="border-t border-brand-100 pt-5">
            <Label htmlFor="rotate-token">{hasToken ? 'Reemplazar access token' : 'Configurar access token'}</Label>
            <p className="mb-2 text-xs text-brand-400">
              {hasToken === null ? 'Verificando…' : hasToken ? 'Ya hay un token configurado (cifrado, no se muestra).' : 'Todavía no se ha configurado un token.'}
            </p>
            <div className="flex flex-wrap gap-2">
              <Input
                id="rotate-token"
                type="password"
                className="flex-1"
                value={tokenValue}
                invalid={tokenTouched && !isNotBlank(tokenValue)}
                onChange={(e) => setTokenValue(e.target.value)}
                placeholder="EAAG..."
                autoComplete="off"
              />
              <Button type="button" variant="ghost" onClick={handleTokenSave} disabled={tokenSaving}>
                {tokenSaving ? 'Guardando…' : 'Guardar'}
              </Button>
            </div>
            <FieldError message={tokenTouched && !isNotBlank(tokenValue) ? 'Ingresa un access token.' : undefined} />
            {tokenError && <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{tokenError}</p>}
            {tokenSaved && <p className="mt-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">Token actualizado.</p>}
          </div>
        )}
      </div>
    </Drawer>
  )
}
