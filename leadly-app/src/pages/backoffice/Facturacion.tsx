import { useEffect, useState, type FormEvent } from 'react'
import {
  getPlatformPaymentCredentialStatus,
  listBillingPlans,
  setPlatformPaymentCredentialSecret,
  setPlatformPaymentMode,
} from '../../lib/api/billing'
import type { BillingPlan } from '../../types/domain'
import { Badge, Button, Card, EmptyState, Input, Label, PageSpinner, Pagination, Select, Table, TBody, TD, TH, THead, TRow } from '../../components/ui'
import { CreditCardIcon, KeyIcon, PencilIcon, PlusIcon } from '../../components/icons'
import { PlanDrawer } from './billing/PlanDrawer'
import { useLanguage } from '../../contexts/LanguageContext'
import type { TranslationKey } from '../../i18n/translations'

const PAGE_SIZE = 8

const TABS = ['planes', 'configuracion'] as const
type Tab = (typeof TABS)[number]
const TAB_LABEL_KEY: Record<Tab, TranslationKey> = {
  planes: 'backoffice.facturacion.tabs.planes',
  configuracion: 'backoffice.facturacion.tabs.configuracion',
}
const TAB_ICON: Record<Tab, typeof CreditCardIcon> = {
  planes: CreditCardIcon,
  configuracion: KeyIcon,
}

function WompiCredentialCard() {
  const { t } = useLanguage()
  const [mode, setMode] = useState<'sandbox' | 'production'>('sandbox')
  const [configuredSecrets, setConfiguredSecrets] = useState<string[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [privateKeyInput, setPrivateKeyInput] = useState('')
  const [integrityKeyInput, setIntegrityKeyInput] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [success, setSuccess] = useState(false)

  function reload() {
    getPlatformPaymentCredentialStatus()
      .then((status) => {
        setMode(status.mode)
        setConfiguredSecrets(status.configuredSecrets)
        setLoaded(true)
      })
      .catch((err) => setError(err.message ?? t('backoffice.facturacion.errors.loadConfig')))
  }

  useEffect(reload, [])

  async function handleModeChange(next: 'sandbox' | 'production') {
    setError(null)
    try {
      await setPlatformPaymentMode(next)
      setMode(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('backoffice.facturacion.errors.mode'))
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!privateKeyInput.trim() && !integrityKeyInput.trim()) return
    setSubmitting(true)
    setError(null)
    setSuccess(false)
    try {
      if (privateKeyInput.trim()) await setPlatformPaymentCredentialSecret('private_key', privateKeyInput.trim())
      if (integrityKeyInput.trim()) await setPlatformPaymentCredentialSecret('integrity_key', integrityKeyInput.trim())
      setPrivateKeyInput('')
      setIntegrityKeyInput('')
      setSuccess(true)
      reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('backoffice.facturacion.errors.credentials'))
    } finally {
      setSubmitting(false)
    }
  }

  const privateKeyConfigured = configuredSecrets.includes('private_key')
  const integrityKeyConfigured = configuredSecrets.includes('integrity_key')
  const fullyConfigured = privateKeyConfigured && integrityKeyConfigured

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-brand-800">Wompi</h2>
        {loaded && (
          <Badge tone={fullyConfigured ? 'success' : 'warning'}>
            {fullyConfigured ? t('backoffice.facturacion.configured') : t('backoffice.facturacion.incomplete')}
          </Badge>
        )}
      </div>
      <p className="mb-3 text-sm text-brand-400">{t('backoffice.facturacion.wompiHint')}</p>

      <div className="mb-4 max-w-[200px]">
        <Label htmlFor="wompi-mode">{t('backoffice.facturacion.mode')}</Label>
        <Select id="wompi-mode" value={mode} onChange={(e) => handleModeChange(e.target.value as 'sandbox' | 'production')}>
          <option value="sandbox">{t('backoffice.facturacion.mode.sandbox')}</option>
          <option value="production">{t('backoffice.facturacion.mode.production')}</option>
        </Select>
      </div>

      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="wompi-private-key">
              {privateKeyConfigured ? t('backoffice.facturacion.privateKey.replace') : t('backoffice.facturacion.privateKey')}
            </Label>
            <Input id="wompi-private-key" type="password" value={privateKeyInput} onChange={(e) => setPrivateKeyInput(e.target.value)} placeholder="prv_..." autoComplete="off" />
          </div>
          <div>
            <Label htmlFor="wompi-integrity-key">
              {integrityKeyConfigured ? t('backoffice.facturacion.integrityKey.replace') : t('backoffice.facturacion.integrityKey')}
            </Label>
            <Input id="wompi-integrity-key" type="password" value={integrityKeyInput} onChange={(e) => setIntegrityKeyInput(e.target.value)} autoComplete="off" />
          </div>
        </div>
        <Button type="submit" variant="secondary" disabled={submitting || (!privateKeyInput.trim() && !integrityKeyInput.trim())}>
          {submitting ? t('common.actions.saving') : t('common.actions.save')}
        </Button>
      </form>
      {success && <p className="mt-2 text-xs text-emerald-600">{t('backoffice.facturacion.credentialsSaved')}</p>}
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </Card>
  )
}

function PlansSection() {
  const { t } = useLanguage()
  const [plans, setPlans] = useState<BillingPlan[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [drawer, setDrawer] = useState<{ open: boolean; plan: BillingPlan | null }>({ open: false, plan: null })
  const [page, setPage] = useState(1)

  function reload() {
    listBillingPlans()
      .then(setPlans)
      .catch((err) => setError(err.message ?? t('backoffice.facturacion.errors.loadPlans')))
  }

  useEffect(reload, [])

  const totalPages = plans ? Math.max(1, Math.ceil(plans.length / PAGE_SIZE)) : 1
  const pageItems = plans ? plans.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) : null

  function handleSaved(plan: BillingPlan) {
    setPlans((prev) => {
      if (!prev) return [plan]
      const exists = prev.some((p) => p.id === plan.id)
      return exists ? prev.map((p) => (p.id === plan.id ? plan : p)) : [plan, ...prev]
    })
  }

  return (
    <>
      <Card>
        <div className="mb-3 flex items-center justify-between">
          <p className="text-sm text-brand-400">{t('backoffice.facturacion.plansSubtitle')}</p>
          <Button variant="secondary" onClick={() => setDrawer({ open: true, plan: null })} className="!px-3 !py-1.5 text-xs">
            <PlusIcon width={14} height={14} /> {t('backoffice.facturacion.newPlan')}
          </Button>
        </div>
        {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        {!plans && !error && <PageSpinner />}
        {plans && plans.length === 0 && <EmptyState>{t('backoffice.facturacion.plansEmpty')}</EmptyState>}
        {pageItems && pageItems.length > 0 && (
          <>
            <Table bare>
              <THead>
                <tr>
                  <TH>{t('backoffice.facturacion.table.plan')}</TH>
                  <TH>{t('backoffice.facturacion.table.price')}</TH>
                  <TH>{t('backoffice.facturacion.table.interval')}</TH>
                  <TH>{t('backoffice.facturacion.table.status')}</TH>
                  <TH className="text-right">{t('backoffice.facturacion.table.actions')}</TH>
                </tr>
              </THead>
              <TBody>
                {pageItems.map((plan) => (
                  <TRow key={plan.id}>
                    <TD className="cursor-pointer font-medium text-brand-800" onClick={() => setDrawer({ open: true, plan })}>
                      {plan.name}
                    </TD>
                    <TD>{new Intl.NumberFormat('es-CO', { style: 'currency', currency: plan.currency, maximumFractionDigits: 0 }).format(plan.amount_cents / 100)}</TD>
                    <TD>{plan.billing_interval === 'monthly' ? t('backoffice.facturacion.interval.monthly') : t('backoffice.facturacion.interval.yearly')}</TD>
                    <TD>
                      <Badge tone={plan.is_active ? 'success' : 'neutral'}>{plan.is_active ? t('common.status.active') : t('common.status.inactive')}</Badge>
                    </TD>
                    <TD className="text-right">
                      <Button variant="ghost" onClick={() => setDrawer({ open: true, plan })} className="!px-3 !py-1.5 text-xs">
                        <PencilIcon width={14} height={14} /> {t('common.actions.edit')}
                      </Button>
                    </TD>
                  </TRow>
                ))}
              </TBody>
            </Table>
            <Pagination page={page} totalPages={totalPages} onChange={setPage} />
          </>
        )}
      </Card>

      <PlanDrawer open={drawer.open} onClose={() => setDrawer({ open: false, plan: null })} plan={drawer.plan} onSaved={handleSaved} />
    </>
  )
}

export function Facturacion() {
  const { t } = useLanguage()
  const [tab, setTab] = useState<Tab>('planes')

  return (
    <div className="space-y-3">
      <div className="flex gap-4 overflow-x-auto border-b border-brand-100">
        {TABS.map((tabKey) => {
          const Icon = TAB_ICON[tabKey]
          return (
            <button
              key={tabKey}
              onClick={() => setTab(tabKey)}
              className={`flex shrink-0 items-center gap-1.5 border-b-2 pb-2 text-xs font-medium transition-colors ${
                tab === tabKey ? 'border-accent-500 text-accent-600' : 'border-transparent text-brand-400 hover:text-brand-700'
              }`}
            >
              <Icon width={13} height={13} />
              {t(TAB_LABEL_KEY[tabKey])}
            </button>
          )
        })}
      </div>

      <div key={tab} className="animate-tab-fade-in">
        {tab === 'planes' && <PlansSection />}
        {tab === 'configuracion' && <WompiCredentialCard />}
      </div>
    </div>
  )
}
