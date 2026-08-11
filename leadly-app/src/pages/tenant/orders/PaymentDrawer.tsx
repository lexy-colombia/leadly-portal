import { useEffect, useState, type FormEvent } from 'react'
import { createPayment } from '../../../lib/api/orderPayments'
import type { OrderPaymentMethod } from '../../../types/domain'
import { Button, CurrencyInput, Drawer, FieldError, Input, Label, Select, Textarea } from '../../../components/ui'

const METHOD_LABEL: Record<OrderPaymentMethod, string> = {
  efectivo: 'Efectivo',
  transferencia: 'Transferencia',
  tarjeta: 'Tarjeta',
  otro: 'Otro',
}

/** Creation only -- a payment logged by mistake is deleted and re-created
 * from VentaDetalle.tsx, never edited in place (see the plan's reasoning:
 * keeps this consistent with the rest of the CRM's "simple by default"
 * criterion instead of adding an edit path nothing else needs yet). */
export function PaymentDrawer({
  open,
  onClose,
  tenantId,
  orderId,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  tenantId: string
  orderId: string
  onSaved: () => void
}) {
  const [method, setMethod] = useState<OrderPaymentMethod>('efectivo')
  const [amount, setAmount] = useState('')
  const [paidAt, setPaidAt] = useState('')
  const [notes, setNotes] = useState('')
  const [touched, setTouched] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setMethod('efectivo')
    setAmount('')
    setPaidAt(new Date().toISOString().slice(0, 10))
    setNotes('')
    setTouched(false)
    setFormError(null)
  }, [open])

  const amountError = touched && !(Number(amount) > 0) ? 'Ingresa un monto válido.' : undefined

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    setFormError(null)
    if (!(Number(amount) > 0)) return

    setSubmitting(true)
    try {
      await createPayment({
        tenant_id: tenantId,
        order_id: orderId,
        method,
        amount: Number(amount),
        paid_at: paidAt || undefined,
        notes: notes.trim() || null,
      })
      onSaved()
      onClose()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'No se pudo registrar el pago.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Drawer open={open} onClose={onClose} title="Registrar pago" description="Se suma al saldo pagado de esta venta.">
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        <div>
          <Label htmlFor="payment-method">Método</Label>
          <Select id="payment-method" value={method} onChange={(e) => setMethod(e.target.value as OrderPaymentMethod)}>
            {(Object.keys(METHOD_LABEL) as OrderPaymentMethod[]).map((m) => (
              <option key={m} value={m}>
                {METHOD_LABEL[m]}
              </option>
            ))}
          </Select>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="payment-amount">Monto</Label>
            <CurrencyInput id="payment-amount" value={amount} invalid={!!amountError} onChange={(e) => setAmount(e.target.value)} />
            <FieldError message={amountError} />
          </div>
          <div>
            <Label htmlFor="payment-date">Fecha de pago</Label>
            <Input id="payment-date" type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} />
          </div>
        </div>

        <div>
          <Label htmlFor="payment-notes">Notas (opcional)</Label>
          <Textarea id="payment-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>

        {formError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</p>}

        <div className="flex gap-2 border-t border-brand-100 pt-5">
          <Button type="submit" variant="secondary" disabled={submitting}>
            {submitting ? 'Guardando…' : 'Guardar'}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
        </div>
      </form>
    </Drawer>
  )
}
