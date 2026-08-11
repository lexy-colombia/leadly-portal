import { useEffect, useState, type FormEvent } from 'react'
import { createBillingPlan, updateBillingPlan, type BillingPlanInput } from '../../../lib/api/billing'
import type { BillingPlan } from '../../../types/domain'
import { Button, CurrencyInput, Drawer, FieldError, Input, Label, Select, Switch } from '../../../components/ui'
import { isNotBlank } from '../../../lib/validation'

export function PlanDrawer({
  open,
  onClose,
  plan,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  /** Present when editing an existing plan; omitted when creating a new one. */
  plan?: BillingPlan | null
  onSaved: (plan: BillingPlan) => void
}) {
  const [key, setKey] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [amount, setAmount] = useState('')
  const [billingInterval, setBillingInterval] = useState<'monthly' | 'yearly'>('monthly')
  const [isActive, setIsActive] = useState(true)
  const [touched, setTouched] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setKey(plan?.key ?? '')
    setName(plan?.name ?? '')
    setDescription(plan?.description ?? '')
    setAmount(plan ? String(plan.amount_cents / 100) : '')
    setBillingInterval(plan?.billing_interval ?? 'monthly')
    setIsActive(plan?.is_active ?? true)
    setTouched(false)
    setFormError(null)
  }, [open, plan])

  const keyError = touched && !isNotBlank(key) ? 'La clave es obligatoria.' : undefined
  const nameError = touched && !isNotBlank(name) ? 'El nombre es obligatorio.' : undefined
  const amountError = touched && (!amount || Number(amount) <= 0) ? 'Ingresa un monto válido.' : undefined

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    setFormError(null)
    if (!isNotBlank(key) || !isNotBlank(name) || !amount || Number(amount) <= 0) return

    setSubmitting(true)
    try {
      const input: BillingPlanInput = {
        key: key.trim(),
        name: name.trim(),
        description: description.trim() || null,
        amount_cents: Math.round(Number(amount) * 100),
        currency: 'COP',
        billing_interval: billingInterval,
        is_active: isActive,
      }
      const saved = plan ? await updateBillingPlan(plan.id, input) : await createBillingPlan(input)
      onSaved(saved)
      onClose()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'No se pudo guardar el plan.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Drawer open={open} onClose={onClose} title={plan ? 'Editar plan' : 'Nuevo plan'} description="Plan de suscripción de Leadly para tus clientes.">
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        <div>
          <Label htmlFor="plan-name">Nombre</Label>
          <Input id="plan-name" value={name} invalid={!!nameError} onChange={(e) => setName(e.target.value)} placeholder="Plan Pro" />
          <FieldError message={nameError} />
        </div>

        <div>
          <Label htmlFor="plan-key">Clave interna</Label>
          <Input id="plan-key" value={key} invalid={!!keyError} onChange={(e) => setKey(e.target.value)} placeholder="pro" disabled={!!plan} />
          <FieldError message={keyError} />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="plan-amount">Monto (COP)</Label>
            <CurrencyInput id="plan-amount" min={1} step={1} value={amount} invalid={!!amountError} onChange={(e) => setAmount(e.target.value)} />
            <FieldError message={amountError} />
          </div>
          <div>
            <Label htmlFor="plan-interval">Periodicidad</Label>
            <Select id="plan-interval" value={billingInterval} onChange={(e) => setBillingInterval(e.target.value as 'monthly' | 'yearly')}>
              <option value="monthly">Mensual</option>
              <option value="yearly">Anual</option>
            </Select>
          </div>
        </div>

        <div>
          <Label htmlFor="plan-description">Descripción (opcional)</Label>
          <Input id="plan-description" value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>

        <div className="flex items-center justify-between rounded-lg border border-brand-100 px-3 py-2.5">
          <span className="text-sm text-brand-700">Plan activo</span>
          <Switch checked={isActive} onChange={setIsActive} />
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
