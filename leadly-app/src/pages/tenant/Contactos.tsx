import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { listContacts } from '../../lib/api/contacts'
import type { CrmContact } from '../../types/domain'
import { Badge, Button, Card, EmptyState, IconInput, InitialsAvatar, PageSpinner, Select, Table, TBody, TD, TH, THead, TRow } from '../../components/ui'
import { PlusIcon, SearchIcon } from '../../components/icons'
import { ContactDrawer, STAGE_LABEL } from './contacts/ContactDrawer'
import type { ContactStage } from '../../types/domain'

const STAGE_TONE: Record<ContactStage, 'neutral' | 'success' | 'warning' | 'danger'> = {
  lead: 'neutral',
  contactado: 'warning',
  negociacion: 'warning',
  cliente: 'success',
  perdido: 'danger',
}

export function Contactos() {
  const { profile } = useAuth()
  const navigate = useNavigate()
  const [contacts, setContacts] = useState<CrmContact[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [stageFilter, setStageFilter] = useState<ContactStage | ''>('')
  const [tagFilter, setTagFilter] = useState('')
  const [drawerOpen, setDrawerOpen] = useState(false)

  useEffect(() => {
    if (!profile?.tenant_id) return
    listContacts(profile.tenant_id)
      .then(setContacts)
      .catch((err) => setError(err.message ?? 'No se pudieron cargar los clientes.'))
  }, [profile?.tenant_id])

  const allTags = useMemo(() => {
    if (!contacts) return []
    return Array.from(new Set(contacts.flatMap((c) => c.tags))).sort()
  }, [contacts])

  const filtered = useMemo(() => {
    if (!contacts) return null
    const term = search.trim().toLowerCase()
    return contacts.filter((c) => {
      if (stageFilter && c.stage !== stageFilter) return false
      if (tagFilter && !c.tags.includes(tagFilter)) return false
      if (!term) return true
      return (
        c.full_name.toLowerCase().includes(term) ||
        c.phone.includes(term) ||
        c.company?.toLowerCase().includes(term) ||
        c.tags.some((tag) => tag.toLowerCase().includes(term))
      )
    })
  }, [contacts, search, stageFilter, tagFilter])

  const hasActiveFilters = !!search || !!stageFilter || !!tagFilter

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-brand-800 sm:text-2xl">Clientes</h1>
          <p className="text-sm text-brand-400">Tu CRM: contactos, etapa y todo lo que has hablado con ellos.</p>
        </div>
        <Button variant="secondary" onClick={() => setDrawerOpen(true)}>
          <PlusIcon width={16} height={16} /> Nuevo cliente
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="w-full max-w-[220px]">
          <IconInput
            icon={<SearchIcon width={14} height={14} />}
            placeholder="Buscar..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="!py-1.5 !pl-8 text-sm"
          />
        </div>
        <Select value={stageFilter} onChange={(e) => setStageFilter(e.target.value as ContactStage | '')} className="!w-auto !py-1.5 text-sm">
          <option value="">Todas las etapas</option>
          {(Object.keys(STAGE_LABEL) as ContactStage[]).map((s) => (
            <option key={s} value={s}>
              {STAGE_LABEL[s]}
            </option>
          ))}
        </Select>
        {allTags.length > 0 && (
          <Select value={tagFilter} onChange={(e) => setTagFilter(e.target.value)} className="!w-auto !py-1.5 text-sm">
            <option value="">Todas las etiquetas</option>
            {allTags.map((tag) => (
              <option key={tag} value={tag}>
                {tag}
              </option>
            ))}
          </Select>
        )}
        {hasActiveFilters && (
          <button
            type="button"
            onClick={() => {
              setSearch('')
              setStageFilter('')
              setTagFilter('')
            }}
            className="text-xs font-medium text-brand-400 hover:text-brand-700"
          >
            Limpiar filtros
          </button>
        )}
      </div>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {!contacts && !error && <PageSpinner />}

      {filtered && filtered.length === 0 && (
        <Card>
          <EmptyState>
            {contacts && contacts.length > 0 ? 'Ningún cliente coincide con tu búsqueda.' : 'Todavía no tienes clientes registrados.'}
          </EmptyState>
        </Card>
      )}

      {filtered && filtered.length > 0 && (
        <Table>
          <THead>
            <tr>
              <TH>Cliente</TH>
              <TH>Teléfono</TH>
              <TH>Etapa</TH>
              <TH>Etiquetas</TH>
            </tr>
          </THead>
          <TBody>
            {filtered.map((contact) => (
              <TRow key={contact.id} onClick={() => navigate(`/app/clientes/${contact.id}`)} clickable>
                <TD className="font-medium text-brand-800">
                  <span className="flex items-center gap-3">
                    <InitialsAvatar name={contact.full_name} size="sm" />
                    <span>
                      {contact.full_name}
                      {contact.company && <span className="block text-xs font-normal text-brand-400">{contact.company}</span>}
                    </span>
                  </span>
                </TD>
                <TD>{contact.phone}</TD>
                <TD>
                  <Badge tone={STAGE_TONE[contact.stage]}>{STAGE_LABEL[contact.stage]}</Badge>
                </TD>
                <TD>
                  <span className="flex flex-wrap gap-1">
                    {contact.tags.map((tag) => (
                      <span key={tag} className="rounded-full bg-brand-50 px-2 py-0.5 text-xs text-brand-500">
                        {tag}
                      </span>
                    ))}
                  </span>
                </TD>
              </TRow>
            ))}
          </TBody>
        </Table>
      )}

      {profile?.tenant_id && (
        <ContactDrawer
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          tenantId={profile.tenant_id}
          onSaved={(c) => setContacts((prev) => (prev ? [c, ...prev] : [c]))}
        />
      )}
    </div>
  )
}
