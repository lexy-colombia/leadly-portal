import { useEffect, useState, type FormEvent } from 'react'
import { createBillingPlan, updateBillingPlan, type BillingPlanInput } from '../../../lib/api/billing'
import type { BillingPlan } from '../../../types/domain'
import { Button, FieldError, Input, Label, Select, Switch } from '@/components/atoms'
import { CurrencyInput } from '@/components/molecules'
import { Drawer } from '@/components/organisms'
import { isNotBlank } from '../../../lib/validation'
import { useLanguage } from '../../../contexts/LanguageContext'

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
  const { t } = useLanguage()
  const [key, setKey] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [amount, setAmount] = useState('')
  const [billingInterval, setBillingInterval] = useState<'monthly' | 'yearly'>('monthly')
  const [maxUsers, setMaxUsers] = useState('')
  const [maxWhatsappLines, setMaxWhatsappLines] = useState('')
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
    setMaxUsers(plan?.max_users != null ? String(plan.max_users) : '')
    setMaxWhatsappLines(plan?.max_whatsapp_lines != null ? String(plan.max_whatsapp_lines) : '')
    setIsActive(plan?.is_active ?? true)
    setTouched(false)
    setFormError(null)
  }, [open, plan])

  const keyError = touched && !isNotBlank(key) ? t('backoffice.planDrawer.errors.key') : undefined
  const nameError = touched && !isNotBlank(name) ? t('backoffice.planDrawer.errors.name') : undefined
  const amountError = touched && (!amount || Number(amount) <= 0) ? t('backoffice.planDrawer.errors.amount') : undefined

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
        max_users: maxUsers.trim() ? Number(maxUsers) : null,
        max_whatsapp_lines: maxWhatsappLines.trim() ? Number(maxWhatsappLines) : null,
        is_active: isActive,
      }
      const saved = plan ? await updateBillingPlan(plan.id, input) : await createBillingPlan(input)
      onSaved(saved)
      onClose()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('backoffice.planDrawer.errors.save'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={plan ? t('backoffice.planDrawer.titleEdit') : t('backoffice.planDrawer.titleNew')}
      description={t('backoffice.planDrawer.description')}
    >
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        <div>
          <Label htmlFor="plan-name">{t('backoffice.planDrawer.name')}</Label>
          <Input id="plan-name" value={name} invalid={!!nameError} onChange={(e) => setName(e.target.value)} placeholder="Plan Pro" />
          <FieldError message={nameError} />
        </div>

        <div>
          <Label htmlFor="plan-key">{t('backoffice.planDrawer.key')}</Label>
          <Input id="plan-key" value={key} invalid={!!keyError} onChange={(e) => setKey(e.target.value)} placeholder="pro" disabled={!!plan} />
          <FieldError message={keyError} />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="plan-amount">{t('backoffice.planDrawer.amount')}</Label>
            <CurrencyInput id="plan-amount" min={1} step={1} value={amount} invalid={!!amountError} onChange={(e) => setAmount(e.target.value)} />
            <FieldError message={amountError} />
          </div>
          <div>
            <Label htmlFor="plan-interval">{t('backoffice.planDrawer.interval')}</Label>
            <Select id="plan-interval" value={billingInterval} onChange={(e) => setBillingInterval(e.target.value as 'monthly' | 'yearly')}>
              <option value="monthly">{t('backoffice.facturacion.interval.monthly')}</option>
              <option value="yearly">{t('backoffice.facturacion.interval.yearly')}</option>
            </Select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="plan-max-users">{t('backoffice.planDrawer.maxUsers')}</Label>
            <Input
              id="plan-max-users"
              type="number"
              min={1}
              step={1}
              value={maxUsers}
              onChange={(e) => setMaxUsers(e.target.value)}
              placeholder={t('backoffice.planDrawer.maxUsers.placeholder')}
            />
          </div>
          <div>
            <Label htmlFor="plan-max-lines">{t('backoffice.planDrawer.maxWhatsappLines')}</Label>
            <Input
              id="plan-max-lines"
              type="number"
              min={1}
              step={1}
              value={maxWhatsappLines}
              onChange={(e) => setMaxWhatsappLines(e.target.value)}
              placeholder={t('backoffice.planDrawer.maxWhatsappLines.placeholder')}
            />
          </div>
        </div>

        <div>
          <Label htmlFor="plan-description">{t('backoffice.planDrawer.descriptionField')}</Label>
          <Input id="plan-description" value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>

        <div className="flex items-center justify-between rounded-lg border border-brand-100 px-3 py-2.5">
          <span className="text-sm text-brand-700">{t('backoffice.planDrawer.activePlan')}</span>
          <Switch checked={isActive} onChange={setIsActive} />
        </div>

        {formError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</p>}

        <div className="flex gap-2 border-t border-brand-100 pt-5">
          <Button type="submit" variant="secondary" disabled={submitting}>
            {submitting ? t('common.actions.saving') : t('common.actions.save')}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('common.actions.cancel')}
          </Button>
        </div>
      </form>
    </Drawer>
  )
}
