import { useEffect, useState, type FormEvent } from 'react'
import { createBillingPlan, listPlanModuleKeys, setPlanModules, updateBillingPlan, type BillingPlanInput } from '../../../lib/api/billing'
import type { BillingPlan } from '../../../types/domain'
import { FieldError } from '@/components/atoms'
import { CurrencyInput } from '@/components/molecules'
import { Drawer } from '@/components/organisms'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { isNotBlank } from '../../../lib/validation'
import { useLanguage } from '../../../contexts/LanguageContext'
import type { TranslationKey } from '../../../i18n/translations'
import { PLAN_MODULE_GROUPS, moduleLabelKey } from '../../../lib/planModules'
import { PlanModuleChecklist } from './PlanModuleChecklist'

type LimitKey = 'max_users' | 'max_warehouses' | 'max_pos_points' | 'max_whatsapp_lines' | 'max_ai_agents' | 'max_ai_messages_month'

const LIMIT_FIELDS: { key: LimitKey; labelKey: TranslationKey }[] = [
  { key: 'max_users', labelKey: 'backoffice.planDrawer.limits.maxUsers' },
  { key: 'max_warehouses', labelKey: 'backoffice.planDrawer.limits.maxWarehouses' },
  { key: 'max_pos_points', labelKey: 'backoffice.planDrawer.limits.maxPosPoints' },
  { key: 'max_whatsapp_lines', labelKey: 'backoffice.planDrawer.limits.maxWhatsappLines' },
  { key: 'max_ai_agents', labelKey: 'backoffice.planDrawer.limits.maxAiAgents' },
  { key: 'max_ai_messages_month', labelKey: 'backoffice.planDrawer.limits.maxAiMessagesMonth' },
]

const EMPTY_LIMITS: Record<LimitKey, string> = {
  max_users: '',
  max_warehouses: '',
  max_pos_points: '',
  max_whatsapp_lines: '',
  max_ai_agents: '',
  max_ai_messages_month: '',
}

/** Empty box = unlimited (null), "0" = none -- the two must stay distinct. */
function limitToInput(value: string): number | null {
  return value.trim() === '' ? null : Number(value)
}

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
  const [setupFee, setSetupFee] = useState('')
  const [billingInterval, setBillingInterval] = useState<'monthly' | 'yearly'>('monthly')
  const [limits, setLimits] = useState<Record<LimitKey, string>>(EMPTY_LIMITS)
  const [sortOrder, setSortOrder] = useState('0')
  const [isActive, setIsActive] = useState(true)
  const [isPublic, setIsPublic] = useState(true)
  const [isCustom, setIsCustom] = useState(false)
  const [moduleKeys, setModuleKeys] = useState<Set<string>>(new Set())
  const [loadingModules, setLoadingModules] = useState(false)
  const [modulesLoadError, setModulesLoadError] = useState(false)
  const [touched, setTouched] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setKey(plan?.key ?? '')
    setName(plan?.name ?? '')
    setDescription(plan?.description ?? '')
    setAmount(plan ? String(plan.amount_cents / 100) : '')
    setSetupFee(plan && plan.setup_fee_cents ? String(plan.setup_fee_cents / 100) : '')
    setBillingInterval(plan?.billing_interval ?? 'monthly')
    setLimits({
      max_users: plan?.max_users != null ? String(plan.max_users) : '',
      max_warehouses: plan?.max_warehouses != null ? String(plan.max_warehouses) : '',
      max_pos_points: plan?.max_pos_points != null ? String(plan.max_pos_points) : '',
      max_whatsapp_lines: plan?.max_whatsapp_lines != null ? String(plan.max_whatsapp_lines) : '',
      max_ai_agents: plan?.max_ai_agents != null ? String(plan.max_ai_agents) : '',
      max_ai_messages_month: plan?.max_ai_messages_month != null ? String(plan.max_ai_messages_month) : '',
    })
    setSortOrder(String(plan?.sort_order ?? 0))
    setIsActive(plan?.is_active ?? true)
    setIsPublic(plan?.is_public ?? true)
    setIsCustom(plan?.is_custom ?? false)
    setTouched(false)
    setFormError(null)
    setModulesLoadError(false)
    if (plan) {
      // Preload the plan's current modules: starting from an empty checklist
      // would make a save-without-touching wipe them all.
      setLoadingModules(true)
      listPlanModuleKeys(plan.id)
        .then(setModuleKeys)
        .catch(() => {
          setModuleKeys(new Set())
          setModulesLoadError(true)
        })
        .finally(() => setLoadingModules(false))
    } else {
      setModuleKeys(new Set())
    }
  }, [open, plan])

  const keyError = touched && !isNotBlank(key) ? t('backoffice.planDrawer.errors.key') : undefined
  const nameError = touched && !isNotBlank(name) ? t('backoffice.planDrawer.errors.name') : undefined
  const amountError = touched && !isCustom && amount.trim() === '' ? t('backoffice.planDrawer.errors.amount') : undefined

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    setFormError(null)
    if (!isNotBlank(key) || !isNotBlank(name) || (!isCustom && amount.trim() === '')) return

    setSubmitting(true)
    try {
      const input: BillingPlanInput = {
        key: key.trim(),
        name: name.trim(),
        description: description.trim() || null,
        // A custom plan has no list price: it's negotiated per tenant on
        // its subscription, so the plan row carries 0.
        amount_cents: isCustom ? 0 : Math.round(Number(amount) * 100),
        setup_fee_cents: isCustom || setupFee.trim() === '' ? 0 : Math.round(Number(setupFee) * 100),
        currency: 'COP',
        billing_interval: billingInterval,
        max_users: limitToInput(limits.max_users),
        max_warehouses: limitToInput(limits.max_warehouses),
        max_pos_points: limitToInput(limits.max_pos_points),
        max_whatsapp_lines: limitToInput(limits.max_whatsapp_lines),
        max_ai_agents: limitToInput(limits.max_ai_agents),
        max_ai_messages_month: limitToInput(limits.max_ai_messages_month),
        sort_order: sortOrder.trim() === '' ? 0 : Number(sortOrder),
        is_public: isPublic,
        is_custom: isCustom,
        is_active: isActive,
      }
      const saved = plan ? await updateBillingPlan(plan.id, input) : await createBillingPlan(input)
      // Custom plans take their modules from each subscription, and a failed
      // preload must never be saved over the real set.
      if (!isCustom && !modulesLoadError) await setPlanModules(saved.id, moduleKeys)
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
      size="lg"
    >
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="plan-name">{t('backoffice.planDrawer.name')}</Label>
            <Input id="plan-name" value={name} aria-invalid={!!nameError} onChange={(e) => setName(e.target.value)} placeholder="Plan Pro" />
            <FieldError message={nameError} />
          </div>
          <div>
            <Label htmlFor="plan-key">{t('backoffice.planDrawer.key')}</Label>
            <Input id="plan-key" value={key} aria-invalid={!!keyError} onChange={(e) => setKey(e.target.value)} placeholder="pro" disabled={!!plan} />
            <FieldError message={keyError} />
          </div>
        </div>

        <div>
          <Label htmlFor="plan-description">{t('backoffice.planDrawer.descriptionField')}</Label>
          <Input id="plan-description" value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>

        <label className="flex items-start gap-2 rounded-lg border border-brand-100 px-3 py-2.5">
          <Checkbox checked={isCustom} onCheckedChange={(checked) => setIsCustom(checked === true)} className="mt-0.5" />
          <span>
            <span className="block text-xs font-medium text-brand-700">{t('backoffice.planDrawer.custom.label')}</span>
            <span className="block text-xs text-brand-400">{t('backoffice.planDrawer.custom.hint')}</span>
          </span>
        </label>

        {isCustom ? (
          <p className="rounded-lg bg-brand-50 px-3 py-2 text-xs text-brand-500">{t('backoffice.planDrawer.custom.note')}</p>
        ) : (
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="plan-amount">{t('backoffice.planDrawer.amount')}</Label>
              <CurrencyInput id="plan-amount" min={0} step={1} value={amount} invalid={!!amountError} onChange={(e) => setAmount(e.target.value)} />
              <FieldError message={amountError} />
            </div>
            <div>
              <Label htmlFor="plan-setup-fee">{t('backoffice.planDrawer.setupFee')}</Label>
              <CurrencyInput id="plan-setup-fee" min={0} step={1} value={setupFee} onChange={(e) => setSetupFee(e.target.value)} />
              <p className="mt-1 text-[11px] text-brand-400">{t('backoffice.planDrawer.setupFee.hint')}</p>
            </div>
          </div>
        )}

        <div>
          <Label htmlFor="plan-interval">{t('backoffice.planDrawer.interval')}</Label>
          <Select value={billingInterval} onValueChange={(v) => setBillingInterval(v as 'monthly' | 'yearly')}>
            <SelectTrigger id="plan-interval" className="mt-1 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="monthly">{t('backoffice.facturacion.interval.monthly')}</SelectItem>
              <SelectItem value="yearly">{t('backoffice.facturacion.interval.yearly')}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div>
          <p className="text-[11px] font-semibold tracking-wide text-brand-400 uppercase">{t('backoffice.planDrawer.limits.title')}</p>
          <p className="mt-0.5 text-xs text-brand-400">{t('backoffice.planDrawer.limits.rule')}</p>
          <div className="mt-2 grid grid-cols-2 gap-4">
            {LIMIT_FIELDS.map((field) => (
              <div key={field.key}>
                <Label htmlFor={`plan-${field.key}`}>{t(field.labelKey)}</Label>
                <Input
                  id={`plan-${field.key}`}
                  type="number"
                  min={0}
                  step={1}
                  value={limits[field.key]}
                  onChange={(e) => setLimits((prev) => ({ ...prev, [field.key]: e.target.value }))}
                  placeholder={t('backoffice.planDrawer.limits.unlimited')}
                />
              </div>
            ))}
          </div>
        </div>

        {!isCustom && (
          <div>
            <p className="text-[11px] font-semibold tracking-wide text-brand-400 uppercase">{t('backoffice.planDrawer.modules.title')}</p>
            <p className="mt-0.5 text-xs text-brand-400">{t('backoffice.planDrawer.modules.hint')}</p>
            {loadingModules ? (
              <p className="mt-2 text-xs text-brand-400">{t('common.actions.loading')}</p>
            ) : (
              <>
                {modulesLoadError && <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{t('backoffice.planDrawer.modules.loadError')}</p>}
                <div className="mt-2">
                  <PlanModuleChecklist
                    groups={PLAN_MODULE_GROUPS}
                    selected={moduleKeys}
                    onChange={setModuleKeys}
                    labelFor={(k) => {
                      const labelKey = moduleLabelKey(k)
                      return labelKey ? t(labelKey) : k
                    }}
                    disabled={modulesLoadError}
                  />
                </div>
              </>
            )}
          </div>
        )}

        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="plan-sort-order">{t('backoffice.planDrawer.sortOrder')}</Label>
            <Input id="plan-sort-order" type="number" step={1} value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} />
          </div>
        </div>

        <div className="flex items-center justify-between rounded-lg border border-brand-100 px-3 py-2.5">
          <span className="text-xs text-brand-700">{t('backoffice.planDrawer.activePlan')}</span>
          <Switch checked={isActive} onCheckedChange={setIsActive} />
        </div>
        <div className="flex items-center justify-between rounded-lg border border-brand-100 px-3 py-2.5">
          <span className="text-xs text-brand-700">{t('backoffice.planDrawer.isPublic')}</span>
          <Switch checked={isPublic} onCheckedChange={setIsPublic} />
        </div>

        {formError && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{formError}</p>}

        <div className="flex gap-2 border-t border-brand-100 pt-5">
          <Button type="submit" disabled={submitting || loadingModules}>
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
