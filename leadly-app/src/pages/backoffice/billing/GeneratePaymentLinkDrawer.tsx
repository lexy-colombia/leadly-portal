import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  createPaymentLink,
  newIdempotencyKey,
  pesosToCents,
  type CreatedPaymentLink,
  type PaymentClient,
} from '../../../lib/api/paymentLinks'
import { FieldError } from '@/components/atoms'
import { CurrencyInput } from '@/components/molecules'
import { Drawer } from '@/components/organisms'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useLanguage } from '../../../contexts/LanguageContext'
import { useToast } from '../../../contexts/ToastContext'
import { CopyButton } from './CopyButton'

/** "Generar link": crea un link a nombre de un proyecto vía POST /admin/links.
 *
 * Idempotencia: la Idempotency-Key se genera UNA vez por intento de envío
 * (al abrir el drawer / al generar otro) y se reenvía igual en cada
 * reintento, mismo patrón que `checkout_token` del POS. Si el usuario edita
 * un campo después de un fallo la clave se renueva: el contrato responde
 * PY409 a la misma clave con un cuerpo distinto. */
export function GeneratePaymentLinkDrawer({
  open,
  onClose,
  projects,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  projects: PaymentClient[]
  onCreated: () => void
}) {
  const { t } = useLanguage()
  const toast = useToast()
  const [clientId, setClientId] = useState('')
  const [amount, setAmount] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [reference, setReference] = useState('')
  const [expiresAt, setExpiresAt] = useState('')
  const [redirectUrl, setRedirectUrl] = useState('')
  const [touched, setTouched] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [result, setResult] = useState<CreatedPaymentLink | null>(null)
  const idempotencyKey = useRef(newIdempotencyKey())

  function reset() {
    setClientId('')
    setAmount('')
    setName('')
    setDescription('')
    setReference('')
    setExpiresAt('')
    setRedirectUrl('')
    setTouched(false)
    setFormError(null)
    setResult(null)
    idempotencyKey.current = newIdempotencyKey()
  }

  useEffect(() => {
    if (open) reset()
  }, [open])

  /** Cualquier edición invalida el reintento "idéntico": clave nueva. */
  function edit<T>(setter: (v: T) => void) {
    return (value: T) => {
      idempotencyKey.current = newIdempotencyKey()
      setter(value)
    }
  }

  const required = t('paymentLinks.generate.errors.required')
  const errors = {
    clientId: touched && !clientId ? required : undefined,
    amount: touched && !amount ? required : undefined,
    name: touched && !name.trim() ? required : undefined,
    description: touched && !description.trim() ? required : undefined,
    reference: touched && !reference.trim() ? required : undefined,
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    setFormError(null)
    // Solo se exige presencia para poder armar el cuerpo; toda regla de
    // negocio (monto mínimo, https, vencimiento) la decide el backend.
    if (!clientId || !amount || !name.trim() || !description.trim() || !reference.trim()) return

    setSubmitting(true)
    try {
      const created = await createPaymentLink({
        clientId,
        idempotencyKey: idempotencyKey.current,
        amountInCents: pesosToCents(Number(amount)),
        name: name.trim(),
        description: description.trim(),
        externalReference: reference.trim(),
        redirectUrl: redirectUrl.trim() || null,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
      })
      setResult(created)
      onCreated()
    } catch (err) {
      const message = err instanceof Error ? err.message : t('common.status.error')
      setFormError(message)
      toast.error(message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={result ? t('paymentLinks.generate.resultTitle') : t('paymentLinks.generate.title')}
      description={result ? undefined : t('paymentLinks.generate.description')}
    >
      {result ? (
        <div className="space-y-4">
          <p className="text-xs text-brand-500">{t('paymentLinks.generate.resultStatus', { status: t(`paymentLinks.linkStatus.${result.status}`) })}</p>
          <div>
            <label htmlFor="pay-result-url" className="mb-1 block text-xs font-medium text-brand-700">
              {t('paymentLinks.generate.checkoutUrl')}
            </label>
            {result.checkout_url ? (
              <div className="flex items-center gap-2">
                <input
                  id="pay-result-url"
                  readOnly
                  autoFocus
                  value={result.checkout_url}
                  onFocus={(e) => e.currentTarget.select()}
                  className="min-w-0 flex-1 rounded-lg border border-brand-200 bg-brand-50 px-2.5 py-1.5 font-mono text-xs text-brand-800"
                />
                <CopyButton value={result.checkout_url} label={t('paymentLinks.copyUrl')} />
              </div>
            ) : (
              <p className="text-xs text-brand-400">{t('paymentLinks.links.noCheckoutUrl')}</p>
            )}
          </div>
          <div className="flex gap-2 border-t border-brand-100 pt-5">
            <Button type="button" onClick={reset}>
              {t('paymentLinks.generate.another')}
            </Button>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t('common.actions.close')}
            </Button>
          </div>
        </div>
      ) : (
        <form onSubmit={handleSubmit} noValidate className="space-y-4">
          <div>
            <Label htmlFor="pay-link-project">{t('paymentLinks.generate.project')}</Label>
            <Select value={clientId} onValueChange={edit(setClientId)}>
              <SelectTrigger id="pay-link-project" className="mt-1 w-full" aria-invalid={!!errors.clientId}>
                <SelectValue placeholder={t('paymentLinks.generate.projectPlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {projects.length === 0 && <p className="mt-1 text-xs text-brand-400">{t('paymentLinks.generate.noProjects')}</p>}
            <FieldError message={errors.clientId} />
          </div>

          <div>
            <Label htmlFor="pay-link-amount">{t('paymentLinks.generate.amount')}</Label>
            <CurrencyInput
              id="pay-link-amount"
              min={1}
              step={1}
              value={amount}
              invalid={!!errors.amount}
              onChange={(e) => edit(setAmount)(e.target.value)}
            />
            <FieldError message={errors.amount} />
          </div>

          <div>
            <Label htmlFor="pay-link-name">{t('paymentLinks.generate.name')}</Label>
            <Input id="pay-link-name" value={name} aria-invalid={!!errors.name} onChange={(e) => edit(setName)(e.target.value)} />
            <FieldError message={errors.name} />
          </div>

          <div>
            <Label htmlFor="pay-link-description">{t('paymentLinks.generate.descriptionField')}</Label>
            <Textarea
              id="pay-link-description"
              rows={3}
              value={description}
              aria-invalid={!!errors.description}
              onChange={(e) => edit(setDescription)(e.target.value)}
            />
            <FieldError message={errors.description} />
          </div>

          <div>
            <Label htmlFor="pay-link-reference">{t('paymentLinks.generate.reference')}</Label>
            <Input id="pay-link-reference" value={reference} aria-invalid={!!errors.reference} onChange={(e) => edit(setReference)(e.target.value)} />
            <FieldError message={errors.reference} />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="pay-link-expires">{t('paymentLinks.generate.expiresAt')}</Label>
              <Input id="pay-link-expires" type="datetime-local" value={expiresAt} onChange={(e) => edit(setExpiresAt)(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="pay-link-redirect">{t('paymentLinks.generate.redirectUrl')}</Label>
              <Input
                id="pay-link-redirect"
                type="url"
                inputMode="url"
                placeholder="https://"
                value={redirectUrl}
                onChange={(e) => edit(setRedirectUrl)(e.target.value)}
              />
            </div>
          </div>

          {formError && (
            <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
              {formError}
            </p>
          )}

          <div className="flex gap-2 border-t border-brand-100 pt-5">
            <Button type="submit" disabled={submitting}>
              {submitting ? t('paymentLinks.generate.submitting') : t('paymentLinks.generate.submit')}
            </Button>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
          </div>
        </form>
      )}
    </Drawer>
  )
}
