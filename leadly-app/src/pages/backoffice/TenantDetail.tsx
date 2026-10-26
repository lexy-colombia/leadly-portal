import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'
import { getTenant, setTenantStatus } from '../../lib/api/tenants'
import { listProfilesByTenant } from '../../lib/api/users'
import type { BillingPlan, Profile, Tenant } from '../../types/domain'
import { COUNTRIES, DOCUMENT_TYPES, LANGUAGES } from '../../lib/referenceData'
import { useCityName } from '../../lib/useCityName'
import { InitialsAvatar, PageSpinner } from '@/components/atoms'
import { Card } from '@/components/molecules'
import { BuildingIcon, CreditCardIcon, GlobeIcon, IdCardIcon, MailIcon, MapPinIcon, MenuIcon, PencilIcon, PhoneIcon, PlusIcon, ReceiptIcon, UsersIcon } from '@/components/atoms/icons'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { TenantDrawer } from './TenantDrawer'
import { WhatsappLineDrawer } from './WhatsappLineDrawer'
import { UserInviteDrawer } from '../shared/UserInviteDrawer'
import { UsersTable } from '../shared/UsersTable'
import { LinesAndAgentsSection } from '../shared/LinesAndAgentsSection'
import { TenantBillingSection } from './billing/TenantBillingSection'
import { TenantPlanSection } from './billing/TenantPlanSection'
import { TenantModulesSection } from './TenantModulesSection'
import { AiSparkleIcon, FileIcon, DashboardIcon } from '@/components/atoms/icons'
import { useLanguage } from '../../contexts/LanguageContext'

// bg/text pair on top of shadcn Badge's `outline` variant, same convention
// as TenantsList.tsx's TENANT_STATUS_BADGE_CLASS.
const TENANT_STATUS_BADGE_CLASS: Record<Tenant['status'], string> = {
  active: 'border-transparent bg-emerald-100 text-emerald-700',
  inactive: 'border-transparent bg-slate-100 text-slate-600',
}

export function TenantDetail() {
  const { t } = useLanguage()
  const { id } = useParams<{ id: string }>()
  const [tenant, setTenant] = useState<Tenant | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!id) return
    let active = true
    getTenant(id)
      .then((data) => active && setTenant(data))
      .catch((err) => active && setError(err.message ?? t('backoffice.clienteDetalle.errors.load')))
    return () => {
      active = false
    }
  }, [id, t])

  if (error) return <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>
  if (tenant === undefined) return <PageSpinner />
  if (tenant === null) {
    return (
      <div className="space-y-4">
        <p className="text-brand-500">{t('backoffice.clienteDetalle.notFound')}</p>
        <Link to="/backoffice/clients" className="text-xs font-medium text-accent-600 hover:text-accent-700">
          {t('backoffice.clienteDetalle.backToClients')}
        </Link>
      </div>
    )
  }

  return <ClienteDetalleContent tenant={tenant} onTenantChange={setTenant} />
}

/** Label-above-value field with a leading icon -- one shape for every fact
 * about the tenant in the sidebar sheet, instead of a dt/dd table grid. Same
 * visual language as ClientDetail's Field on the tenant side. */
function Field({ icon, label, value }: { icon: ReactNode; label: string; value: ReactNode }) {
  return (
    <div className="flex items-start gap-2.5">
      <span className="mt-0.5 shrink-0 text-brand-300">{icon}</span>
      <div className="min-w-0">
        <p className="text-xs text-brand-400">{label}</p>
        <p className="break-words text-xs font-medium leading-relaxed text-brand-700">{value}</p>
      </div>
    </div>
  )
}

function ClienteDetalleContent({ tenant, onTenantChange }: { tenant: Tenant; onTenantChange: (t: Tenant) => void }) {
  const { t } = useLanguage()
  const [tab, setTab] = useState('resumen')
  const panelRef = useRef<HTMLDivElement>(null)
  const [editOpen, setEditOpen] = useState(false)
  const [actionsOpen, setActionsOpen] = useState(false)
  const [confirmingDeactivate, setConfirmingDeactivate] = useState(false)
  const [statusUpdating, setStatusUpdating] = useState(false)
  const [statusError, setStatusError] = useState<string | null>(null)

  const queryClient = useQueryClient()
  const [inviteOpen, setInviteOpen] = useState(false)
  const [plan, setPlan] = useState<BillingPlan | null>(null)

  const usersQuery = useQuery<Profile[]>({
    queryKey: ['tenantUsers', tenant.id],
    queryFn: () => listProfilesByTenant(tenant.id),
  })
  const users = usersQuery.data
  const usersError = usersQuery.error instanceof Error ? usersQuery.error.message : usersQuery.error ? t('backoffice.clienteDetalle.errors.loadUsers') : null

  async function handleActivate() {
    setStatusUpdating(true)
    setStatusError(null)
    try {
      onTenantChange(await setTenantStatus(tenant.id, 'active'))
      setActionsOpen(false)
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : t('backoffice.clienteDetalle.errors.activate'))
    } finally {
      setStatusUpdating(false)
    }
  }

  async function handleDeactivate() {
    setStatusUpdating(true)
    setStatusError(null)
    try {
      onTenantChange(await setTenantStatus(tenant.id, 'inactive'))
      setConfirmingDeactivate(false)
      setActionsOpen(false)
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : t('backoffice.clienteDetalle.errors.deactivate'))
    } finally {
      setStatusUpdating(false)
    }
  }

  const maxUsers = plan?.max_users ?? null
  const activeUserCount = users?.filter((u) => u.active).length ?? 0
  const atUserCapacity = maxUsers !== null && activeUserCount >= maxUsers

  const cityName = useCityName(tenant.city_code)
  const countryLabelKey = COUNTRIES.find((c) => c.code === tenant.country)?.labelKey
  const countryLabel = countryLabelKey ? t(countryLabelKey) : (tenant.country ?? '—')
  const documentTypeLabelKey = DOCUMENT_TYPES.find((d) => d.value === tenant.document_type)?.labelKey
  const documentTypeLabel = documentTypeLabelKey ? t(documentTypeLabelKey) : '—'
  const languageLabelKey = LANGUAGES.find((l) => l.value === tenant.preferred_language)?.labelKey
  const languageLabel = languageLabelKey ? t(languageLabelKey) : tenant.preferred_language

  return (
    <div className="animate-fade-in flex min-w-0 flex-col gap-4 md:h-[calc(100dvh-102px)] md:min-h-0 lg:h-[calc(100dvh-126px)]">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
        <div className="flex items-start gap-3">
          {tenant.logo_url ? (
            <img src={tenant.logo_url} alt="" className="h-12 w-12 shrink-0 rounded-xl object-cover" />
          ) : (
            <InitialsAvatar name={tenant.name} size="md" />
          )}
          <div>
            <Link to="/backoffice/clients" className="text-[11px] font-medium text-brand-400 hover:text-brand-600">
              {t('backoffice.clienteDetalle.breadcrumb')}
            </Link>
            <div className="mt-0.5 flex items-center gap-2">
              <h1 className="text-lg font-bold tracking-tight text-brand-800">{tenant.name}</h1>
              <Badge variant="outline" className={TENANT_STATUS_BADGE_CLASS[tenant.status]}>
                {tenant.status === 'active' ? t('common.status.active') : t('common.status.inactive')}
              </Badge>
            </div>
            <p className="mt-1 text-xs text-brand-400">{documentTypeLabel} {tenant.document_number ?? '—'} · {countryLabel}{cityName ? `, ${cityName}` : ''}</p>
          </div>
        </div>

        <div className="relative flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
            <PencilIcon data-icon="inline-start" width={14} height={14} />{t('backoffice.clienteDetalle.editAria')}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setActionsOpen((o) => !o)} className="text-xs">
            {t('backoffice.clienteDetalle.moreActions')}
          </Button>
          {actionsOpen && (
            <div className="absolute right-0 top-full z-40 mt-2 w-64 rounded-xl border border-brand-100 bg-white p-1.5 shadow-lg">
              {statusError && <p className="mb-1 rounded-lg bg-red-50 px-2 py-1.5 text-xs text-red-700">{statusError}</p>}
              {tenant.status === 'active' ? (
                confirmingDeactivate ? (
                  <div className="space-y-1.5 p-1">
                    <p className="px-2 text-xs text-brand-500">{t('backoffice.clienteDetalle.deactivateConfirm')}</p>
                    <Button variant="destructive" size="sm" onClick={handleDeactivate} disabled={statusUpdating} className="w-full text-xs">
                      {statusUpdating ? t('backoffice.clienteDetalle.deactivating') : t('backoffice.clienteDetalle.deactivateYes')}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setConfirmingDeactivate(false)} className="w-full text-xs">
                      {t('common.actions.cancel')}
                    </Button>
                  </div>
                ) : (
                  <button
                    onClick={() => setConfirmingDeactivate(true)}
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-red-600 hover:bg-red-50"
                  >
                    {t('backoffice.clienteDetalle.deactivate')}
                  </button>
                )
              ) : (
                <button
                  onClick={handleActivate}
                  disabled={statusUpdating}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-brand-700 hover:bg-brand-50"
                >
                  {statusUpdating ? t('backoffice.clienteDetalle.activating') : t('backoffice.clienteDetalle.activate')}
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      <Tabs value={tab} onValueChange={(value) => { setTab(value); panelRef.current?.scrollTo({ top: 0 }) }} orientation="vertical" className="min-h-0 flex-1 !flex-col overflow-hidden rounded-lg border border-border bg-card md:!flex-row md:gap-0">
        <TabsList aria-label={t('backoffice.clienteDetalle.sections')} className="!grid w-full shrink-0 grid-cols-2 gap-1 rounded-none border-b border-border bg-muted/40 p-2 sm:grid-cols-4 md:!flex md:w-44 md:items-stretch md:justify-start md:border-b-0 md:border-r md:p-3 md:!h-full">
          <TabsTrigger className="!h-8 !flex-none px-2" value="resumen"><DashboardIcon />{t('backoffice.clienteDetalle.tabs.resumen')}</TabsTrigger>
          <TabsTrigger className="!h-8 !flex-none px-2" value="plan"><CreditCardIcon />{t('backoffice.clienteDetalle.tabs.plan')}</TabsTrigger>
          <TabsTrigger className="!h-8 !flex-none px-2" value="lineas"><PhoneIcon />{t('backoffice.clienteDetalle.tabs.lineas')}</TabsTrigger>
          <TabsTrigger className="!h-8 !flex-none px-2" value="agentes"><AiSparkleIcon />{t('settings.lines.tabs.agents')}</TabsTrigger>
          <TabsTrigger className="!h-8 !flex-none px-2" value="plantillas"><FileIcon />{t('settings.templates.tabs.templates')}</TabsTrigger>
          <TabsTrigger className="!h-8 !flex-none px-2" value="usuarios"><UsersIcon />{t('backoffice.clienteDetalle.tabs.usuarios')}<span className="ml-auto text-[10px] text-muted-foreground">{users?.length ?? '—'}</span></TabsTrigger>
          <TabsTrigger className="!h-8 !flex-none px-2" value="facturacion"><ReceiptIcon />{t('backoffice.clienteDetalle.tabs.facturacion')}</TabsTrigger>
          <TabsTrigger className="!h-8 !flex-none px-2" value="modulos"><MenuIcon />{t('backoffice.clienteDetalle.tabs.modulos')}</TabsTrigger>
        </TabsList>
        <div ref={panelRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain p-4 sm:p-5">
          <TabsContent value="resumen">
            <div className="mb-5 flex items-start justify-between gap-3">
              <div><h2 className="text-sm font-bold text-foreground">{t('backoffice.clienteDetalle.tabs.resumen')}</h2><p className="mt-1 text-xs text-muted-foreground">{t('backoffice.clienteDetalle.overviewHint')}</p></div>
              <Badge variant="outline">{tenant.entity_type === 'empresa' ? t('backoffice.clienteDetalle.entityType.empresa') : t('backoffice.clienteDetalle.entityType.persona')}</Badge>
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              <section className="rounded-lg border border-border p-4">
                <h3 className="mb-4 text-xs font-semibold text-foreground">{t('backoffice.clienteDetalle.companyInfo')}</h3>
                <div className="flex flex-col gap-4">
                  <Field icon={<BuildingIcon width={14} height={14} />} label={tenant.entity_type === 'empresa' ? t('backoffice.clienteDetalle.fields.legalName') : t('backoffice.clienteDetalle.fields.fullName')} value={tenant.legal_name ?? '—'} />
                  <Field icon={<IdCardIcon width={14} height={14} />} label={t('backoffice.clienteDetalle.fields.document')} value={tenant.document_number ? `${documentTypeLabel} ${tenant.document_number}` : '—'} />
                  <Field icon={<MapPinIcon width={14} height={14} />} label={t('backoffice.clienteDetalle.fields.country')} value={[countryLabel, tenant.state_province, cityName].filter(Boolean).join(', ')} />
                  <Field icon={<ReceiptIcon width={14} height={14} />} label={t('backoffice.clienteDetalle.fields.billingAddress')} value={tenant.billing_address ?? '—'} />
                </div>
              </section>
              <section className="rounded-lg border border-border p-4">
                <h3 className="mb-4 text-xs font-semibold text-foreground">{t('backoffice.clienteDetalle.contactInfo')}</h3>
                <div className="flex flex-col gap-4">
                  <Field icon={<MailIcon width={14} height={14} />} label={t('backoffice.clienteDetalle.fields.contactEmail')} value={tenant.contact_email ? <a href={`mailto:${tenant.contact_email}`} className="hover:underline">{tenant.contact_email}</a> : '—'} />
                  <Field icon={<PhoneIcon width={14} height={14} />} label={t('backoffice.clienteDetalle.fields.contactPhone')} value={tenant.contact_phone ? <a href={`tel:${tenant.contact_phone}`} className="hover:underline">{tenant.contact_phone}</a> : '—'} />
                  <Field icon={<GlobeIcon width={14} height={14} />} label={t('backoffice.clienteDetalle.fields.preferredLanguage')} value={languageLabel} />
                </div>
              </section>
            </div>
            {tenant.notes && <section className="mt-5"><h3 className="mb-2 text-xs font-semibold">{t('backoffice.clienteDetalle.fields.notes')}</h3><p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">{tenant.notes}</p></section>}
          </TabsContent>
          <TabsContent value="plan" forceMount className="data-[state=inactive]:hidden">
            <h2 className="mb-5 text-sm font-bold">{t('backoffice.clienteDetalle.tabs.plan')}</h2>
            <TenantPlanSection tenantId={tenant.id} onPlanChange={setPlan} />
          </TabsContent>
          {(['lineas', 'agentes', 'plantillas'] as const).map((section) => (
            <TabsContent key={section} value={section}>
              <h2 className="mb-4 text-sm font-bold">{section === 'lineas' ? t('backoffice.clienteDetalle.tabs.lineas') : section === 'agentes' ? t('settings.lines.tabs.agents') : t('settings.templates.tabs.templates')}</h2>
              <LinesAndAgentsSection
                tenantId={tenant.id}
                canManage
                manageSkills
                tabs={[section]}
                showMetrics={section === 'lineas'}
                renderLineDrawer={({ open, line, onClose, onSaved }) => (
                  <WhatsappLineDrawer open={open} onClose={onClose} tenantId={tenant.id} line={line} onSaved={onSaved} />
                )}
              />
            </TabsContent>
          ))}
          <TabsContent value="usuarios">
            <h2 className="mb-4 text-sm font-bold">{t('backoffice.clienteDetalle.tabs.usuarios')}</h2>
              <Card>
                <div className="mb-1 flex items-center justify-between">
                  <p className="text-xs text-brand-500">{t('backoffice.clienteDetalle.usersSubtitle')}</p>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setInviteOpen(true)}
                    disabled={atUserCapacity}
                    className="text-xs"
                    title={atUserCapacity ? t('backoffice.clienteDetalle.usersAtCapacity', { max: maxUsers ?? 0 }) : undefined}
                  >
                    <PlusIcon width={14} height={14} /> {t('backoffice.clienteDetalle.inviteUser')}
                  </Button>
                </div>
                {maxUsers !== null && (
                  <p className={`mb-3 text-xs ${atUserCapacity ? 'text-amber-600' : 'text-brand-400'}`}>
                    {t('backoffice.clienteDetalle.usersCount', { active: activeUserCount, max: maxUsers })}
                  </p>
                )}
                {usersError && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{usersError}</p>}
                {usersQuery.isLoading && <PageSpinner />}
                {users && (
                  <UsersTable
                    users={users}
                    onChange={(u) =>
                      queryClient.setQueryData<Profile[]>(['tenantUsers', tenant.id], (prev) => prev?.map((p) => (p.id === u.id ? u : p)) ?? prev)
                    }
                    disableActivate={atUserCapacity}
                  />
                )}
              </Card>
          </TabsContent>
          <TabsContent value="facturacion">
            <h2 className="mb-4 text-sm font-bold">{t('backoffice.clienteDetalle.tabs.facturacion')}</h2>
            <TenantBillingSection tenantId={tenant.id} />
          </TabsContent>
          <TabsContent value="modulos">
            <h2 className="mb-4 text-sm font-bold">{t('backoffice.clienteDetalle.tabs.modulos')}</h2>
            <TenantModulesSection tenantId={tenant.id} />
          </TabsContent>
        </div>
      </Tabs>

      <TenantDrawer open={editOpen} onClose={() => setEditOpen(false)} tenant={tenant} onSaved={onTenantChange} />

      <UserInviteDrawer open={inviteOpen} onClose={() => setInviteOpen(false)} tenantId={tenant.id} />

    </div>
  )
}
