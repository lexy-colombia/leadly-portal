import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { getTenant, setTenantStatus } from '../../lib/api/tenants'
import { listWhatsappLinesByTenant } from '../../lib/api/whatsappLines'
import { listProfilesByTenant } from '../../lib/api/users'
import type { Profile, Tenant, WhatsappLine, WhatsappLineStatus } from '../../types/domain'
import { COUNTRIES, DOCUMENT_TYPES, LANGUAGES } from '../../lib/referenceData'
import { Badge, Button, Card, CardSection, EmptyState, InitialsAvatar, PageSpinner, Table, TBody, TD, TH, THead, TRow } from '../../components/ui'
import { AiSparkleIcon, PencilIcon, PhoneIcon, PlusIcon } from '../../components/icons'
import { TenantDrawer } from './TenantDrawer'
import { WhatsappLineDrawer } from './WhatsappLineDrawer'
import { AiAssistantDrawer } from '../shared/AiAssistantDrawer'
import { UserInviteDrawer } from '../shared/UserInviteDrawer'
import { UsersTable } from '../shared/UsersTable'

const LINE_STATUS_LABEL: Record<WhatsappLineStatus, string> = {
  pending_verification: 'Pendiente',
  active: 'Activa',
  suspended: 'Suspendida',
}

const LINE_STATUS_TONE: Record<WhatsappLineStatus, 'success' | 'warning' | 'danger'> = {
  pending_verification: 'warning',
  active: 'success',
  suspended: 'danger',
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

function ClienteDetalleContent({ tenant, onTenantChange }: { tenant: Tenant; onTenantChange: (t: Tenant) => void }) {
  const [editOpen, setEditOpen] = useState(false)
  const [confirmingDeactivate, setConfirmingDeactivate] = useState(false)
  const [statusUpdating, setStatusUpdating] = useState(false)
  const [statusError, setStatusError] = useState<string | null>(null)

  const [lines, setLines] = useState<WhatsappLine[] | null>(null)
  const [linesError, setLinesError] = useState<string | null>(null)
  const [lineDrawer, setLineDrawer] = useState<{ open: boolean; line: WhatsappLine | null }>({ open: false, line: null })
  const [aiDrawer, setAiDrawer] = useState<{ open: boolean; line: WhatsappLine | null }>({ open: false, line: null })

  const [users, setUsers] = useState<Profile[] | null>(null)
  const [usersError, setUsersError] = useState<string | null>(null)
  const [inviteOpen, setInviteOpen] = useState(false)

  function reloadUsers() {
    listProfilesByTenant(tenant.id)
      .then(setUsers)
      .catch((err) => setUsersError(err.message ?? 'No se pudieron cargar los usuarios.'))
  }

  useEffect(reloadUsers, [tenant.id])

  function reloadLines() {
    listWhatsappLinesByTenant(tenant.id)
      .then(setLines)
      .catch((err) => setLinesError(err.message ?? 'No se pudieron cargar las líneas.'))
  }

  useEffect(reloadLines, [tenant.id])

  async function handleActivate() {
    setStatusUpdating(true)
    setStatusError(null)
    try {
      onTenantChange(await setTenantStatus(tenant.id, 'active'))
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
    <div className="animate-fade-in space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <Link to="/backoffice/clientes" className="text-sm font-medium text-brand-400 hover:text-brand-600">
          Clientes
        </Link>
        <span className="text-brand-300">/</span>
        {tenant.logo_url ? (
          <img src={tenant.logo_url} alt="" className="h-7 w-7 rounded-full object-cover" />
        ) : (
          <InitialsAvatar name={tenant.name} size="sm" />
        )}
        <h1 className="text-xl font-bold text-brand-800 sm:text-2xl">{tenant.name}</h1>
        <Badge tone={tenant.status === 'active' ? 'success' : 'neutral'}>{tenant.status === 'active' ? 'Activo' : 'Inactivo'}</Badge>
      </div>

      <Card padded={false}>
        <CardSection
          title="Información del cliente"
          action={
            <Button variant="ghost" onClick={() => setEditOpen(true)} className="!px-3 !py-1.5 text-xs">
              <PencilIcon width={14} height={14} /> Editar
            </Button>
          }
        >
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
        </CardSection>

        <CardSection title="Estado del cliente">
          <p className="mb-3 text-sm text-brand-500">
            {tenant.status === 'active'
              ? 'Los usuarios de este cliente pueden usar Leadly con normalidad. Al desactivarlo, pierden acceso de inmediato.'
              : 'Este cliente está desactivado: sus usuarios no pueden ver ni usar nada dentro de Leadly hasta que lo reactives.'}
          </p>
          {statusError && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{statusError}</p>}
          {tenant.status === 'active' ? (
            confirmingDeactivate ? (
              <div className="flex flex-wrap gap-2">
                <Button variant="danger" onClick={handleDeactivate} disabled={statusUpdating}>
                  {statusUpdating ? 'Desactivando…' : 'Sí, desactivar cliente'}
                </Button>
                <Button variant="ghost" onClick={() => setConfirmingDeactivate(false)} disabled={statusUpdating}>
                  Cancelar
                </Button>
              </div>
            ) : (
              <Button variant="danger" onClick={() => setConfirmingDeactivate(true)}>
                Desactivar cliente
              </Button>
            )
          ) : (
            <Button variant="secondary" onClick={handleActivate} disabled={statusUpdating}>
              {statusUpdating ? 'Activando…' : 'Activar cliente'}
            </Button>
          )}
        </CardSection>

        <CardSection
          title="Líneas de WhatsApp"
          action={
            <Button variant="secondary" onClick={() => setLineDrawer({ open: true, line: null })} className="!px-3 !py-1.5 text-xs">
              <PlusIcon width={14} height={14} /> Nueva línea
            </Button>
          }
        >
          {linesError && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{linesError}</p>}
          {!lines && !linesError && <PageSpinner />}

          {lines && lines.length === 0 && <EmptyState>Este cliente todavía no tiene líneas de WhatsApp asignadas.</EmptyState>}

          {lines && lines.length > 0 && (
            <Table bare>
              <THead>
                <tr>
                  <TH>Línea</TH>
                  <TH>Estado</TH>
                  <TH className="hidden sm:table-cell">phone_number_id</TH>
                  <TH className="text-right">Acciones</TH>
                </tr>
              </THead>
              <TBody>
                {lines.map((line) => (
                  <TRow key={line.id}>
                    <TD className="cursor-pointer font-medium text-brand-800" onClick={() => setLineDrawer({ open: true, line })}>
                      <span className="flex items-center gap-3">
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-50 text-accent-600">
                          <PhoneIcon width={16} height={16} />
                        </span>
                        {line.display_name}
                      </span>
                    </TD>
                    <TD className="cursor-pointer" onClick={() => setLineDrawer({ open: true, line })}>
                      <Badge tone={LINE_STATUS_TONE[line.status]}>{LINE_STATUS_LABEL[line.status]}</Badge>
                    </TD>
                    <TD
                      className="hidden cursor-pointer sm:table-cell text-brand-400"
                      onClick={() => setLineDrawer({ open: true, line })}
                    >
                      {line.phone_number_id}
                    </TD>
                    <TD className="text-right">
                      <Button variant="ghost" onClick={() => setAiDrawer({ open: true, line })} className="!px-3 !py-1.5 text-xs">
                        <AiSparkleIcon width={14} height={14} /> Asistente de IA
                      </Button>
                    </TD>
                  </TRow>
                ))}
              </TBody>
            </Table>
          )}
        </CardSection>

        <CardSection
          title="Usuarios"
          action={
            <Button variant="secondary" onClick={() => setInviteOpen(true)} className="!px-3 !py-1.5 text-xs">
              <PlusIcon width={14} height={14} /> Invitar usuario
            </Button>
          }
        >
          {usersError && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{usersError}</p>}
          {!users && !usersError && <PageSpinner />}
          {users && <UsersTable users={users} onChange={(u) => setUsers((prev) => prev!.map((p) => (p.id === u.id ? u : p)))} />}
        </CardSection>
      </Card>

      <TenantDrawer open={editOpen} onClose={() => setEditOpen(false)} tenant={tenant} onSaved={onTenantChange} />

      <UserInviteDrawer
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        tenantId={tenant.id}
        onInvited={(p) => setUsers((prev) => [p, ...(prev ?? [])])}
      />

      <WhatsappLineDrawer
        open={lineDrawer.open}
        onClose={() => setLineDrawer({ open: false, line: null })}
        tenantId={tenant.id}
        line={lineDrawer.line}
        onSaved={reloadLines}
      />

      {aiDrawer.line && (
        <AiAssistantDrawer
          open={aiDrawer.open}
          onClose={() => setAiDrawer({ open: false, line: null })}
          whatsappLineId={aiDrawer.line.id}
          lineName={aiDrawer.line.display_name}
        />
      )}
    </div>
  )
}
