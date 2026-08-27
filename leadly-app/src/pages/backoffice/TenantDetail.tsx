import { useEffect, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { getTenant, setTenantStatus } from '../../lib/api/tenants'
import { listProfilesByTenant } from '../../lib/api/users'
import type { BillingPlan, Profile, Tenant } from '../../types/domain'
import { COUNTRIES, DOCUMENT_TYPES, LANGUAGES } from '../../lib/referenceData'
import { InitialsAvatar, PageSpinner } from '@/components/atoms'
import { Card } from '@/components/molecules'
import { BuildingIcon, CreditCardIcon, GlobeIcon, IdCardIcon, MailIcon, MapPinIcon, MenuIcon, PencilIcon, PhoneIcon, PlusIcon, ReceiptIcon, UserIcon, UsersIcon } from '@/components/atoms/icons'
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
  }, [id])

  if (error) return <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
  if (tenant === undefined) return <PageSpinner />
  if (tenant === null) {
    return (
      <div className="space-y-4">
        <p className="text-brand-500">{t('backoffice.clienteDetalle.notFound')}</p>
        <Link to="/backoffice/clients" className="text-sm font-medium text-accent-600 hover:text-accent-700">
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
        <p className="truncate text-sm text-brand-700">{value}</p>
      </div>
    </div>
  )
}

function ClienteDetalleContent({ tenant, onTenantChange }: { tenant: Tenant; onTenantChange: (t: Tenant) => void }) {
  const { t } = useLanguage()
  const [tab, setTab] = useState('lineas')
  const [editOpen, setEditOpen] = useState(false)
  const [actionsOpen, setActionsOpen] = useState(false)
  const [confirmingDeactivate, setConfirmingDeactivate] = useState(false)
  const [statusUpdating, setStatusUpdating] = useState(false)
  const [statusError, setStatusError] = useState<string | null>(null)

  const [users, setUsers] = useState<Profile[] | null>(null)
  const [usersError, setUsersError] = useState<string | null>(null)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [plan, setPlan] = useState<BillingPlan | null>(null)

  function reloadUsers() {
    listProfilesByTenant(tenant.id)
      .then(setUsers)
      .catch((err) => setUsersError(err.message ?? t('backoffice.clienteDetalle.errors.loadUsers')))
  }

  useEffect(reloadUsers, [tenant.id])

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

  const countryLabelKey = COUNTRIES.find((c) => c.code === tenant.country)?.labelKey
  const countryLabel = countryLabelKey ? t(countryLabelKey) : (tenant.country ?? '—')
  const documentTypeLabelKey = DOCUMENT_TYPES.find((d) => d.value === tenant.document_type)?.labelKey
  const documentTypeLabel = documentTypeLabelKey ? t(documentTypeLabelKey) : '—'
  const languageLabelKey = LANGUAGES.find((l) => l.value === tenant.preferred_language)?.labelKey
  const languageLabel = languageLabelKey ? t(languageLabelKey) : tenant.preferred_language

  return (
    <div className="animate-fade-in space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
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
              <h1 className="text-lg font-bold text-brand-800 sm:text-xl">{tenant.name}</h1>
              <button onClick={() => setEditOpen(true)} aria-label={t('backoffice.clienteDetalle.editAria')} className="text-brand-300 hover:text-brand-600">
                <PencilIcon width={14} height={14} />
              </button>
              <Badge variant="outline" className={TENANT_STATUS_BADGE_CLASS[tenant.status]}>
                {tenant.status === 'active' ? t('common.status.active') : t('common.status.inactive')}
              </Badge>
            </div>
          </div>
        </div>

        <div className="relative">
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
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50"
                  >
                    {t('backoffice.clienteDetalle.deactivate')}
                  </button>
                )
              ) : (
                <button
                  onClick={handleActivate}
                  disabled={statusUpdating}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-brand-700 hover:bg-brand-50"
                >
                  {statusUpdating ? t('backoffice.clienteDetalle.activating') : t('backoffice.clienteDetalle.activate')}
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <Card className="lg:w-72 lg:shrink-0">
          <div className="flex items-center gap-2 pb-3">
            <Badge variant="outline">
              {tenant.entity_type === 'empresa' ? t('backoffice.clienteDetalle.entityType.empresa') : t('backoffice.clienteDetalle.entityType.persona')}
            </Badge>
          </div>

          <dl className="space-y-3 border-t border-brand-100 py-4 text-sm">
            <Field
              icon={tenant.entity_type === 'empresa' ? <BuildingIcon width={14} height={14} /> : <UserIcon width={14} height={14} />}
              label={tenant.entity_type === 'empresa' ? t('backoffice.clienteDetalle.fields.legalName') : t('backoffice.clienteDetalle.fields.fullName')}
              value={tenant.legal_name ?? '—'}
            />
            <Field
              icon={<IdCardIcon width={14} height={14} />}
              label={t('backoffice.clienteDetalle.fields.document')}
              value={tenant.document_number ? `${documentTypeLabel} ${tenant.document_number}` : '—'}
            />
            <Field icon={<MailIcon width={14} height={14} />} label={t('backoffice.clienteDetalle.fields.contactEmail')} value={tenant.contact_email ?? '—'} />
            <Field icon={<PhoneIcon width={14} height={14} />} label={t('backoffice.clienteDetalle.fields.contactPhone')} value={tenant.contact_phone ?? '—'} />
            <Field
              icon={<MapPinIcon width={14} height={14} />}
              label={t('backoffice.clienteDetalle.fields.country')}
              value={tenant.state_province ? `${countryLabel}, ${tenant.state_province}` : countryLabel}
            />
            <Field icon={<GlobeIcon width={14} height={14} />} label={t('backoffice.clienteDetalle.fields.preferredLanguage')} value={languageLabel} />
            <Field icon={<ReceiptIcon width={14} height={14} />} label={t('backoffice.clienteDetalle.fields.billingAddress')} value={tenant.billing_address ?? '—'} />
          </dl>

          <div className="border-t border-brand-100 pt-4">
            <TenantPlanSection tenantId={tenant.id} onPlanChange={setPlan} />
          </div>

          {tenant.notes && (
            <div className="border-t border-brand-100 pt-4">
              <p className="mb-1 text-xs font-medium text-brand-400">{t('backoffice.clienteDetalle.fields.notes')}</p>
              <p className="whitespace-pre-wrap text-sm text-brand-600">{tenant.notes}</p>
            </div>
          )}
        </Card>

        <div className="min-w-0 flex-1">
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList>
              <TabsTrigger value="lineas">
                <PhoneIcon width={13} height={13} /> {t('backoffice.clienteDetalle.tabs.lineas')}
              </TabsTrigger>
              <TabsTrigger value="usuarios">
                <UsersIcon width={13} height={13} /> {t('backoffice.clienteDetalle.tabs.usuarios')}
                {users && users.length > 0 && <span className="text-[11px] text-brand-300">({users.length})</span>}
              </TabsTrigger>
              <TabsTrigger value="facturacion">
                <CreditCardIcon width={13} height={13} /> {t('backoffice.clienteDetalle.tabs.facturacion')}
              </TabsTrigger>
              <TabsTrigger value="modulos">
                <MenuIcon width={13} height={13} /> {t('backoffice.clienteDetalle.tabs.modulos')}
              </TabsTrigger>
            </TabsList>

            <TabsContent value="lineas">
              <LinesAndAgentsSection
                tenantId={tenant.id}
                canManage
                manageSkills
                renderLineDrawer={({ open, line, onClose, onSaved }) => (
                  <WhatsappLineDrawer open={open} onClose={onClose} tenantId={tenant.id} line={line} onSaved={onSaved} />
                )}
              />
            </TabsContent>

            <TabsContent value="usuarios">
              <Card>
                <div className="mb-1 flex items-center justify-between">
                  <p className="text-sm text-brand-500">{t('backoffice.clienteDetalle.usersSubtitle')}</p>
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
                {usersError && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{usersError}</p>}
                {!users && !usersError && <PageSpinner />}
                {users && (
                  <UsersTable
                    users={users}
                    onChange={(u) => setUsers((prev) => prev!.map((p) => (p.id === u.id ? u : p)))}
                    disableActivate={atUserCapacity}
                  />
                )}
              </Card>
            </TabsContent>

            <TabsContent value="facturacion">
              <Card padded={false}>
                <TenantBillingSection tenantId={tenant.id} />
              </Card>
            </TabsContent>

            <TabsContent value="modulos">
              <Card>
                <TenantModulesSection tenantId={tenant.id} />
              </Card>
            </TabsContent>
          </Tabs>
        </div>
      </div>

      <TenantDrawer open={editOpen} onClose={() => setEditOpen(false)} tenant={tenant} onSaved={onTenantChange} />

      <UserInviteDrawer
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        tenantId={tenant.id}
        onInvited={(p) => setUsers((prev) => [p, ...(prev ?? [])])}
      />

    </div>
  )
}
