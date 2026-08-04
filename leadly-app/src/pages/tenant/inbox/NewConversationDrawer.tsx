import { useEffect, useMemo, useState } from 'react'
import { listContacts, createContact } from '../../../lib/api/contacts'
import { createConversation } from '../../../lib/api/conversations'
import { listWhatsappLinesByTenant } from '../../../lib/api/whatsappLines'
import type { CrmContact, WhatsappLine } from '../../../types/domain'
import { Button, Drawer, FieldError, IconInput, Input, Label, Select } from '../../../components/ui'
import { SearchIcon, UserIcon } from '../../../components/icons'
import { isNotBlank, isValidE164Phone } from '../../../lib/validation'

export function NewConversationDrawer({
  open,
  onClose,
  tenantId,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  tenantId: string
  onCreated: (conversationId: string) => void
}) {
  const [contacts, setContacts] = useState<CrmContact[]>([])
  const [lines, setLines] = useState<WhatsappLine[]>([])
  const [mode, setMode] = useState<'existing' | 'new'>('existing')
  const [search, setSearch] = useState('')
  const [selectedContactId, setSelectedContactId] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [newPhone, setNewPhone] = useState('')
  const [lineId, setLineId] = useState('')
  const [touched, setTouched] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setMode('existing')
    setSearch('')
    setSelectedContactId(null)
    setNewName('')
    setNewPhone('')
    setTouched(false)
    setFormError(null)
    listContacts(tenantId).then(setContacts).catch(() => setContacts([]))
    listWhatsappLinesByTenant(tenantId).then((all) => {
      const active = all.filter((l) => l.status === 'active')
      setLines(active)
      setLineId(active[0]?.id ?? '')
    })
  }, [open, tenantId])

  const filteredContacts = useMemo(() => {
    const term = search.trim().toLowerCase()
    if (!term) return contacts
    return contacts.filter((c) => c.full_name.toLowerCase().includes(term) || c.phone.includes(term))
  }, [contacts, search])

  const newNameError = touched && mode === 'new' && !isNotBlank(newName) ? 'El nombre es obligatorio.' : undefined
  const newPhoneError = touched && mode === 'new' && !isValidE164Phone(newPhone) ? 'Teléfono inválido (formato internacional).' : undefined
  const contactMissingError = touched && mode === 'existing' && !selectedContactId ? 'Selecciona un cliente.' : undefined

  async function handleSubmit() {
    setTouched(true)
    setFormError(null)

    if (!lineId) {
      setFormError('Necesitas al menos una línea de WhatsApp activa para iniciar una conversación.')
      return
    }
    if (mode === 'existing' && !selectedContactId) return
    if (mode === 'new' && (!isNotBlank(newName) || !isValidE164Phone(newPhone))) return

    setSubmitting(true)
    try {
      let contact: CrmContact
      if (mode === 'existing') {
        contact = contacts.find((c) => c.id === selectedContactId)!
      } else {
        contact = await createContact({
          tenant_id: tenantId,
          full_name: newName.trim(),
          phone: newPhone.trim(),
          stage: 'lead',
          tags: [],
        })
      }

      const conversation = await createConversation(tenantId, lineId, contact.id, contact.phone, contact.full_name)
      onCreated(conversation.id)
      onClose()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'No se pudo iniciar la conversación.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Drawer open={open} onClose={onClose} title="Nueva conversación" description="Elige un cliente existente o crea uno nuevo.">
      <div className="space-y-5">
        <div className="flex gap-2 rounded-xl bg-brand-50 p-1">
          <button
            type="button"
            onClick={() => setMode('existing')}
            className={`flex-1 rounded-lg py-1.5 text-sm font-medium transition-colors ${mode === 'existing' ? 'bg-white text-brand-800 shadow-sm' : 'text-brand-400'}`}
          >
            Cliente existente
          </button>
          <button
            type="button"
            onClick={() => setMode('new')}
            className={`flex-1 rounded-lg py-1.5 text-sm font-medium transition-colors ${mode === 'new' ? 'bg-white text-brand-800 shadow-sm' : 'text-brand-400'}`}
          >
            Cliente nuevo
          </button>
        </div>

        {mode === 'existing' ? (
          <div className="space-y-2">
            <IconInput icon={<SearchIcon width={16} height={16} />} placeholder="Buscar cliente..." value={search} onChange={(e) => setSearch(e.target.value)} />
            <div className="max-h-64 space-y-1 overflow-y-auto">
              {filteredContacts.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setSelectedContactId(c.id)}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                    selectedContactId === c.id ? 'bg-accent-50 text-brand-800' : 'hover:bg-brand-50 text-brand-600'
                  }`}
                >
                  <UserIcon width={14} height={14} className="shrink-0 text-brand-300" />
                  <span className="truncate">
                    {c.full_name} <span className="text-brand-300">· {c.phone}</span>
                  </span>
                </button>
              ))}
              {filteredContacts.length === 0 && <p className="px-3 py-2 text-sm text-brand-400">Sin resultados.</p>}
            </div>
            <FieldError message={contactMissingError} />
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <Label htmlFor="new-conv-name">Nombre completo</Label>
              <Input id="new-conv-name" value={newName} invalid={!!newNameError} onChange={(e) => setNewName(e.target.value)} placeholder="Nombre y apellido" />
              <FieldError message={newNameError} />
            </div>
            <div>
              <Label htmlFor="new-conv-phone">Teléfono (WhatsApp)</Label>
              <Input id="new-conv-phone" value={newPhone} invalid={!!newPhoneError} onChange={(e) => setNewPhone(e.target.value)} placeholder="+573001234567" />
              <FieldError message={newPhoneError} />
            </div>
          </div>
        )}

        <div>
          <Label htmlFor="new-conv-line">Línea de WhatsApp</Label>
          <Select id="new-conv-line" value={lineId} onChange={(e) => setLineId(e.target.value)} disabled={lines.length === 0}>
            {lines.length === 0 && <option value="">Sin líneas activas</option>}
            {lines.map((l) => (
              <option key={l.id} value={l.id}>
                {l.display_name}
              </option>
            ))}
          </Select>
        </div>

        {formError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</p>}

        <div className="flex gap-2 border-t border-brand-100 pt-5">
          <Button type="button" variant="secondary" onClick={handleSubmit} disabled={submitting}>
            {submitting ? 'Creando…' : 'Iniciar conversación'}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
        </div>
      </div>
    </Drawer>
  )
}
