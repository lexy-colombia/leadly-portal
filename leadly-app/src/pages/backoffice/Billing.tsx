import { useEffect, useState } from 'react'
import { listBillingPlans } from '../../lib/api/billing'
import type { BillingPlan } from '../../types/domain'
import { Badge, Button, PageSpinner, Table, TBody, TD, TH, THead, TRow } from '@/components/atoms'
import { Card, EmptyState, Pagination } from '@/components/molecules'
import { CreditCardIcon, PencilIcon, PlusIcon, ReceiptIcon } from '@/components/atoms/icons'
import { PlanDrawer } from './billing/PlanDrawer'
import { InvoicesSection } from './billing/InvoicesSection'
import { useLanguage } from '../../contexts/LanguageContext'
import type { TranslationKey } from '../../i18n/translations'

const PAGE_SIZE = 8

const TABS = ['planes', 'facturas'] as const
type Tab = (typeof TABS)[number]
const TAB_LABEL_KEY: Record<Tab, TranslationKey> = {
  planes: 'backoffice.facturacion.tabs.planes',
  facturas: 'backoffice.facturacion.tabs.facturas',
}
const TAB_ICON: Record<Tab, typeof CreditCardIcon> = {
  planes: CreditCardIcon,
  facturas: ReceiptIcon,
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
                  <TH>{t('backoffice.facturacion.table.maxUsers')}</TH>
                  <TH>{t('backoffice.facturacion.table.maxWhatsappLines')}</TH>
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
                    <TD className="text-brand-500">{plan.max_users ?? t('backoffice.facturacion.table.maxUsers.unlimited')}</TD>
                    <TD className="text-brand-500">{plan.max_whatsapp_lines ?? t('backoffice.facturacion.table.maxUsers.unlimited')}</TD>
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

export function Billing() {
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
        {tab === 'facturas' && <InvoicesSection />}
      </div>
    </div>
  )
}
