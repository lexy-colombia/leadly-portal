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

const PAGE_SIZE = 8

const TABS = ['planes', 'configuracion'] as const
type Tab = (typeof TABS)[number]
const TAB_LABEL: Record<Tab, string> = {
  planes: 'Planes',
  configuracion: 'Configuración de pago',
}
const TAB_ICON: Record<Tab, typeof CreditCardIcon> = {
  planes: CreditCardIcon,
  configuracion: KeyIcon,
}

function WompiCredentialCard() {
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
      .catch((err) => setError(err.message ?? 'No se pudo consultar la configuración de pago.'))
  }

  useEffect(reload, [])

  async function handleModeChange(next: 'sandbox' | 'production') {
    setError(null)
    try {
      await setPlatformPaymentMode(next)
      setMode(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo cambiar el modo.')
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
      setError(err instanceof Error ? err.message : 'No se pudieron guardar las credenciales.')
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
        {loaded && <Badge tone={fullyConfigured ? 'success' : 'warning'}>{fullyConfigured ? 'Configurada' : 'Incompleta'}</Badge>}
      </div>
      <p className="mb-3 text-sm text-brand-400">Credenciales de Leadly como merchant, usadas para cobrar los planes de suscripción a tus clientes.</p>

      <div className="mb-4 max-w-[200px]">
        <Label htmlFor="wompi-mode">Modo</Label>
        <Select id="wompi-mode" value={mode} onChange={(e) => handleModeChange(e.target.value as 'sandbox' | 'production')}>
          <option value="sandbox">Sandbox</option>
          <option value="production">Producción</option>
        </Select>
      </div>

      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="wompi-private-key">{privateKeyConfigured ? 'Reemplazar Private Key' : 'Private Key'}</Label>
            <Input id="wompi-private-key" type="password" value={privateKeyInput} onChange={(e) => setPrivateKeyInput(e.target.value)} placeholder="prv_..." autoComplete="off" />
          </div>
          <div>
            <Label htmlFor="wompi-integrity-key">{integrityKeyConfigured ? 'Reemplazar Integrity Key' : 'Integrity Key'}</Label>
            <Input id="wompi-integrity-key" type="password" value={integrityKeyInput} onChange={(e) => setIntegrityKeyInput(e.target.value)} autoComplete="off" />
          </div>
        </div>
        <Button type="submit" variant="secondary" disabled={submitting || (!privateKeyInput.trim() && !integrityKeyInput.trim())}>
          {submitting ? 'Guardando…' : 'Guardar'}
        </Button>
      </form>
      {success && <p className="mt-2 text-xs text-emerald-600">Credenciales guardadas correctamente.</p>}
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </Card>
  )
}

function PlansSection() {
  const [plans, setPlans] = useState<BillingPlan[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [drawer, setDrawer] = useState<{ open: boolean; plan: BillingPlan | null }>({ open: false, plan: null })
  const [page, setPage] = useState(1)

  function reload() {
    listBillingPlans()
      .then(setPlans)
      .catch((err) => setError(err.message ?? 'No se pudieron cargar los planes.'))
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
          <p className="text-sm text-brand-400">Planes de suscripción que tus clientes pueden pagar.</p>
          <Button variant="secondary" onClick={() => setDrawer({ open: true, plan: null })} className="!px-3 !py-1.5 text-xs">
            <PlusIcon width={14} height={14} /> Nuevo plan
          </Button>
        </div>
        {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        {!plans && !error && <PageSpinner />}
        {plans && plans.length === 0 && <EmptyState>Todavía no hay planes de suscripción.</EmptyState>}
        {pageItems && pageItems.length > 0 && (
          <>
            <Table bare>
              <THead>
                <tr>
                  <TH>Plan</TH>
                  <TH>Precio</TH>
                  <TH>Periodicidad</TH>
                  <TH>Estado</TH>
                  <TH className="text-right">Acciones</TH>
                </tr>
              </THead>
              <TBody>
                {pageItems.map((plan) => (
                  <TRow key={plan.id}>
                    <TD className="cursor-pointer font-medium text-brand-800" onClick={() => setDrawer({ open: true, plan })}>
                      {plan.name}
                    </TD>
                    <TD>{new Intl.NumberFormat('es-CO', { style: 'currency', currency: plan.currency, maximumFractionDigits: 0 }).format(plan.amount_cents / 100)}</TD>
                    <TD>{plan.billing_interval === 'monthly' ? 'Mensual' : 'Anual'}</TD>
                    <TD>
                      <Badge tone={plan.is_active ? 'success' : 'neutral'}>{plan.is_active ? 'Activo' : 'Inactivo'}</Badge>
                    </TD>
                    <TD className="text-right">
                      <Button variant="ghost" onClick={() => setDrawer({ open: true, plan })} className="!px-3 !py-1.5 text-xs">
                        <PencilIcon width={14} height={14} /> Editar
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
  const [tab, setTab] = useState<Tab>('planes')

  return (
    <div className="space-y-3">
      <div className="flex gap-4 overflow-x-auto border-b border-brand-100">
        {TABS.map((t) => {
          const Icon = TAB_ICON[t]
          return (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex shrink-0 items-center gap-1.5 border-b-2 pb-2 text-xs font-medium transition-colors ${
                tab === t ? 'border-accent-500 text-accent-600' : 'border-transparent text-brand-400 hover:text-brand-700'
              }`}
            >
              <Icon width={13} height={13} />
              {TAB_LABEL[t]}
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
