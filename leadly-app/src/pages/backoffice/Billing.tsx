import { useEffect, useState } from 'react'
import { listBillingPlans } from '../../lib/api/billing'
import type { BillingPlan } from '../../types/domain'
import { PageSpinner } from '@/components/atoms'
import { Card, EmptyState, Pagination } from '@/components/molecules'
import { CreditCardIcon, PencilIcon, PlusIcon, ReceiptIcon } from '@/components/atoms/icons'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
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
          <Button size="sm" onClick={() => setDrawer({ open: true, plan: null })}>
            <PlusIcon width={14} height={14} /> {t('backoffice.facturacion.newPlan')}
          </Button>
        </div>
        {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        {!plans && !error && <PageSpinner />}
        {plans && plans.length === 0 && <EmptyState>{t('backoffice.facturacion.plansEmpty')}</EmptyState>}
        {pageItems && pageItems.length > 0 && (
          <>
            <div className="overflow-hidden rounded-2xl border border-brand-100 bg-white">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('backoffice.facturacion.table.plan')}</TableHead>
                    <TableHead>{t('backoffice.facturacion.table.price')}</TableHead>
                    <TableHead>{t('backoffice.facturacion.table.interval')}</TableHead>
                    <TableHead>{t('backoffice.facturacion.table.maxUsers')}</TableHead>
                    <TableHead>{t('backoffice.facturacion.table.maxWhatsappLines')}</TableHead>
                    <TableHead>{t('backoffice.facturacion.table.status')}</TableHead>
                    <TableHead className="text-right">{t('backoffice.facturacion.table.actions')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pageItems.map((plan) => (
                    <TableRow key={plan.id} onClick={() => setDrawer({ open: true, plan })} className="cursor-pointer">
                      <TableCell className="font-medium text-brand-800">{plan.name}</TableCell>
                      <TableCell>{new Intl.NumberFormat('es-CO', { style: 'currency', currency: plan.currency, maximumFractionDigits: 0 }).format(plan.amount_cents / 100)}</TableCell>
                      <TableCell>{plan.billing_interval === 'monthly' ? t('backoffice.facturacion.interval.monthly') : t('backoffice.facturacion.interval.yearly')}</TableCell>
                      <TableCell className="text-brand-500">{plan.max_users ?? t('backoffice.facturacion.table.maxUsers.unlimited')}</TableCell>
                      <TableCell className="text-brand-500">{plan.max_whatsapp_lines ?? t('backoffice.facturacion.table.maxUsers.unlimited')}</TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={plan.is_active ? 'border-transparent bg-emerald-100 text-emerald-700' : 'border-transparent bg-slate-100 text-slate-600'}
                        >
                          {plan.is_active ? t('common.status.active') : t('common.status.inactive')}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                        <Button variant="ghost" size="xs" onClick={() => setDrawer({ open: true, plan })}>
                          <PencilIcon width={14} height={14} /> {t('common.actions.edit')}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
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
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          {TABS.map((tabKey) => {
            const Icon = TAB_ICON[tabKey]
            return (
              <TabsTrigger key={tabKey} value={tabKey} className="text-xs">
                <Icon width={13} height={13} /> {t(TAB_LABEL_KEY[tabKey])}
              </TabsTrigger>
            )
          })}
        </TabsList>

        <TabsContent value="planes">
          <PlansSection />
        </TabsContent>
        <TabsContent value="facturas">
          <InvoicesSection />
        </TabsContent>
      </Tabs>
    </div>
  )
}
