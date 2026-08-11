import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { getTenant, setTenantStatus } from '../../lib/api/tenants'
import { listProfilesByTenant } from '../../lib/api/users'
import type { Profile, Tenant } from '../../types/domain'
import { COUNTRIES, DOCUMENT_TYPES, LANGUAGES } from '../../lib/referenceData'
import { Badge, Button, Card, InitialsAvatar, PageSpinner } from '../../components/ui'
import { CreditCardIcon, IdCardIcon, MailIcon, PencilIcon, PhoneIcon, PlusIcon, UsersIcon } from '../../components/icons'
import { TenantDrawer } from './TenantDrawer'
import { WhatsappLineDrawer } from './WhatsappLineDrawer'
import { UserInviteDrawer } from '../shared/UserInviteDrawer'
import { UsersTable } from '../shared/UsersTable'
import { LinesAndAgentsSection } from '../shared/LinesAndAgentsSection'
import { TenantBillingSection } from './billing/TenantBillingSection'

const TABS = ['informacion', 'lineas', 'usuarios', 'facturacion'] as const
type Tab = (typeof TABS)[number]
const TAB_LABEL: Record<Tab, string> = {
  informacion: 'Información',
  lineas: 'Líneas de WhatsApp',
  usuarios: 'Usuarios',
  facturacion: 'Facturación',
}
const TAB_ICON: Record<Tab, typeof IdCardIcon> = {
  informacion: IdCardIcon,
  lineas: PhoneIcon,
  usuarios: UsersIcon,
  facturacion: CreditCardIcon,
}

export function ClienteDetalle() {
  const { id } = useParams<{ id: string }>()
  const [tenant, setTenant] = useState<Tenant | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!id) return
    let active = true
    getTenant(id)
      .then((data) => active && setTenant(data))
      .catch((err) => active && setError(err.message ?? 'No se pudo cargar el cliente.'))
    return () => {
      active = false
    }
  }, [id])

  if (error) return <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
  if (tenant === undefined) return <PageSpinner />
  if (tenant === null) {
    return (
      <div className="space-y-4">
        <p className="text-brand-500">No encontramos este cliente.</p>
        <Link to="/backoffice/clientes" className="text-sm font-medium text-accent-600 hover:text-accent-700">
          Volver a Clientes
        </Link>
      </div>
    )
  }

  return <ClienteDetalleContent tenant={tenant} onTenantChange={setTenant} />
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 py-1.5 text-sm">
      <dt className="text-brand-400">{label}</dt>
      <dd className="text-right text-brand-700">{value}</dd>
    </div>
  )
}

function InfoField({ icon: Icon, label, value }: { icon: typeof PhoneIcon; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent-50 text-accent-600">
        <Icon width={13} height={13} />
      </span>
      <div className="min-w-0">
        <p className="text-[11px] text-brand-400">{label}</p>
        <p className="truncate text-xs font-medium text-brand-800">{value}</p>
      </div>
    </div>
  )
}

function ClienteDetalleContent({ tenant, onTenantChange }: { tenant: Tenant; onTenantChange: (t: Tenant) => void }) {
  const [tab, setTab] = useState<Tab>('informacion')
  const [editOpen, setEditOpen] = useState(false)
  const [actionsOpen, setActionsOpen] = useState(false)
  const [confirmingDeactivate, setConfirmingDeactivate] = useState(false)
  const [statusUpdating, setStatusUpdating] = useState(false)
  const [statusError, setStatusError] = useState<string | null>(null)

  const [users, setUsers] = useState<Profile[] | null>(null)
  const [usersError, setUsersError] = useState<string | null>(null)
  const [inviteOpen, setInviteOpen] = useState(false)

  function reloadUsers() {
    listProfilesByTenant(tenant.id)
      .then(setUsers)
      .catch((err) => setUsersError(err.message ?? 'No se pudieron cargar los usuarios.'))
  }

  useEffect(reloadUsers, [tenant.id])

  async function handleActivate() {
    setStatusUpdating(true)
    setStatusError(null)
    try {
      onTenantChange(await setTenantStatus(tenant.id, 'active'))
      setActionsOpen(false)
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : 'No se pudo activar el cliente.')
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
      setStatusError(err instanceof Error ? err.message : 'No se pudo desactivar el cliente.')
    } finally {
      setStatusUpdating(false)
    }
  }

  const countryLabel = COUNTRIES.find((c) => c.code === tenant.country)?.label ?? tenant.country ?? '—'
  const documentTypeLabel = DOCUMENT_TYPES.find((d) => d.value === tenant.document_type)?.label ?? '—'
  const languageLabel = LANGUAGES.find((l) => l.value === tenant.preferred_language)?.label ?? tenant.preferred_language

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
            <Link to="/backoffice/clientes" className="text-[11px] font-medium text-brand-400 hover:text-brand-600">
              Clientes
            </Link>
            <div className="mt-0.5 flex items-center gap-2">
              <h1 className="text-lg font-bold text-brand-800 sm:text-xl">{tenant.name}</h1>
              <button onClick={() => setEditOpen(true)} aria-label="Editar cliente" className="text-brand-300 hover:text-brand-600">
                <PencilIcon width={14} height={14} />
              </button>
              <Badge tone={tenant.status === 'active' ? 'success' : 'neutral'}>{tenant.status === 'active' ? 'Activo' : 'Inactivo'}</Badge>
            </div>
          </div>
        </div>

        <div className="relative">
          <Button variant="ghost" onClick={() => setActionsOpen((o) => !o)} className="!px-2.5 !py-1.5 text-xs">
            Más acciones
          </Button>
          {actionsOpen && (
            <div className="absolute right-0 top-full z-40 mt-2 w-64 rounded-xl border border-brand-100 bg-white p-1.5 shadow-lg">
              {statusError && <p className="mb-1 rounded-lg bg-red-50 px-2 py-1.5 text-xs text-red-700">{statusError}</p>}
              {tenant.status === 'active' ? (
                confirmingDeactivate ? (
                  <div className="space-y-1.5 p-1">
                    <p className="px-2 text-xs text-brand-500">¿Desactivar este cliente? Sus usuarios pierden acceso de inmediato.</p>
                    <Button variant="danger" onClick={handleDeactivate} disabled={statusUpdating} className="!w-full !py-1.5 text-xs">
                      {statusUpdating ? 'Desactivando…' : 'Sí, desactivar'}
                    </Button>
                    <Button variant="ghost" onClick={() => setConfirmingDeactivate(false)} className="!w-full !py-1.5 text-xs">
                      Cancelar
                    </Button>
                  </div>
                ) : (
                  <button
                    onClick={() => setConfirmingDeactivate(true)}
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50"
                  >
                    Desactivar cliente
                  </button>
                )
              ) : (
                <button
                  onClick={handleActivate}
                  disabled={statusUpdating}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-brand-700 hover:bg-brand-50"
                >
                  {statusUpdating ? 'Activando…' : 'Activar cliente'}
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      <Card>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <InfoField icon={MailIcon} label="Correo de contacto" value={tenant.contact_email ?? '—'} />
          <InfoField icon={PhoneIcon} label="Teléfono de contacto" value={tenant.contact_phone ?? '—'} />
          <InfoField icon={IdCardIcon} label="País" value={countryLabel} />
        </div>
      </Card>

      <div className="flex gap-4 overflow-x-auto border-b border-brand-100">
        {TABS.map((t) => {
          const Icon = TAB_ICON[t]
          const count = t === 'usuarios' ? users?.length : undefined
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
              {count !== undefined && count > 0 && <span className="text-[11px] text-brand-300">({count})</span>}
            </button>
          )
        })}
      </div>

      <div key={tab} className="animate-tab-fade-in">
        {tab === 'informacion' && (
          <Card>
            <div className="grid gap-x-8 sm:grid-cols-2">
              <dl className="divide-y divide-brand-50">
                <InfoRow label="Tipo" value={tenant.entity_type === 'empresa' ? 'Empresa' : 'Persona natural'} />
                <InfoRow label={tenant.entity_type === 'empresa' ? 'Razón social' : 'Nombre completo'} value={tenant.legal_name ?? '—'} />
                <InfoRow label="Documento" value={tenant.document_number ? `${documentTypeLabel} ${tenant.document_number}` : '—'} />
                <InfoRow label="Idioma preferido" value={languageLabel} />
              </dl>
              <dl className="divide-y divide-brand-50">
                <InfoRow label="Correo de contacto" value={tenant.contact_email ?? '—'} />
                <InfoRow label="Teléfono de contacto" value={tenant.contact_phone ?? '—'} />
                <InfoRow label="País" value={countryLabel} />
                <InfoRow label="Departamento / estado" value={tenant.state_province ?? '—'} />
              </dl>
            </div>
            {tenant.notes && (
              <p className="mt-4 border-t border-brand-50 pt-4 text-sm text-brand-600">
                <span className="text-brand-400">Notas: </span>
                {tenant.notes}
              </p>
            )}
          </Card>
        )}

        {tab === 'lineas' && (
          <LinesAndAgentsSection
            tenantId={tenant.id}
            canManage
            manageSkills
            renderLineDrawer={({ open, line, onClose, onSaved }) => (
              <WhatsappLineDrawer open={open} onClose={onClose} tenantId={tenant.id} line={line} onSaved={onSaved} />
            )}
          />
        )}

        {tab === 'usuarios' && (
          <Card>
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm text-brand-500">Usuarios con acceso al panel de este cliente.</p>
              <Button variant="secondary" onClick={() => setInviteOpen(true)} className="!px-3 !py-1.5 text-xs">
                <PlusIcon width={14} height={14} /> Invitar usuario
              </Button>
            </div>
            {usersError && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{usersError}</p>}
            {!users && !usersError && <PageSpinner />}
            {users && <UsersTable users={users} onChange={(u) => setUsers((prev) => prev!.map((p) => (p.id === u.id ? u : p)))} />}
          </Card>
        )}

        {tab === 'facturacion' && (
          <Card padded={false}>
            <TenantBillingSection tenantId={tenant.id} />
          </Card>
        )}
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
