import { useEffect, useMemo, useState } from 'react'
import { listClients, createClient } from '../../../lib/api/clients'
import { createConversation } from '../../../lib/api/conversations'
import { listWhatsappLinesByTenant } from '../../../lib/api/whatsappLines'
import type { Client, WhatsappLine } from '../../../types/domain'
import { Button, FieldError, Input, Label, Select } from '@/components/atoms'
import { IconInput } from '@/components/molecules'
import { Drawer } from '@/components/organisms'
import { SearchIcon, UserIcon } from '@/components/atoms/icons'
import { isNotBlank, isValidE164Phone } from '../../../lib/validation'
import { useLanguage } from '../../../contexts/LanguageContext'

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
  const { t } = useLanguage()
  const [contacts, setContacts] = useState<Client[]>([])
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
    listClients(tenantId).then(setContacts).catch(() => setContacts([]))
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

  const newNameError = touched && mode === 'new' && !isNotBlank(newName) ? t('inbox.newConv.errors.nameRequired') : undefined
  const newPhoneError = touched && mode === 'new' && !isValidE164Phone(newPhone) ? t('inbox.newConv.errors.invalidPhone') : undefined
  const contactMissingError = touched && mode === 'existing' && !selectedContactId ? t('inbox.newConv.errors.selectContact') : undefined

  async function handleSubmit() {
    setTouched(true)
    setFormError(null)

    if (!lineId) {
      setFormError(t('inbox.newConv.errors.noActiveLine'))
      return
    }
    if (mode === 'existing' && !selectedContactId) return
    if (mode === 'new' && (!isNotBlank(newName) || !isValidE164Phone(newPhone))) return

    setSubmitting(true)
    try {
      let contact: Client
      if (mode === 'existing') {
        contact = contacts.find((c) => c.id === selectedContactId)!
      } else {
        contact = await createClient({
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
      setFormError(err instanceof Error ? err.message : t('inbox.newConv.errors.createFailed'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Drawer open={open} onClose={onClose} title={t('inbox.newConv.title')} description={t('inbox.newConv.description')}>
      <div className="space-y-5">
        <div className="flex gap-2 rounded-xl bg-brand-50 p-1">
          <button
            type="button"
            onClick={() => setMode('existing')}
            className={`flex-1 rounded-lg py-1.5 text-sm font-medium transition-colors ${mode === 'existing' ? 'bg-white text-brand-800 shadow-sm' : 'text-brand-400'}`}
          >
            {t('inbox.newConv.existingContact')}
          </button>
          <button
            type="button"
            onClick={() => setMode('new')}
            className={`flex-1 rounded-lg py-1.5 text-sm font-medium transition-colors ${mode === 'new' ? 'bg-white text-brand-800 shadow-sm' : 'text-brand-400'}`}
          >
            {t('inbox.newConv.newContact')}
          </button>
        </div>

        {mode === 'existing' ? (
          <div className="space-y-2">
            <IconInput
              icon={<SearchIcon width={16} height={16} />}
              placeholder={t('inbox.newConv.searchContact')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
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
              {filteredContacts.length === 0 && <p className="px-3 py-2 text-sm text-brand-400">{t('common.status.noResults')}</p>}
            </div>
            <FieldError message={contactMissingError} />
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <Label htmlFor="new-conv-name">{t('inbox.newConv.fullName')}</Label>
              <Input
                id="new-conv-name"
                value={newName}
                invalid={!!newNameError}
                onChange={(e) => setNewName(e.target.value)}
                placeholder={t('inbox.newConv.fullNamePlaceholder')}
              />
              <FieldError message={newNameError} />
            </div>
            <div>
              <Label htmlFor="new-conv-phone">{t('inbox.newConv.phone')}</Label>
              <Input id="new-conv-phone" value={newPhone} invalid={!!newPhoneError} onChange={(e) => setNewPhone(e.target.value)} placeholder="+573001234567" />
              <FieldError message={newPhoneError} />
            </div>
          </div>
        )}

        <div>
          <Label htmlFor="new-conv-line">{t('inbox.newConv.line')}</Label>
          <Select id="new-conv-line" value={lineId} onChange={(e) => setLineId(e.target.value)} disabled={lines.length === 0}>
            {lines.length === 0 && <option value="">{t('inbox.newConv.noActiveLines')}</option>}
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
            {submitting ? t('common.actions.creating') : t('inbox.newConv.submit')}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('common.actions.cancel')}
          </Button>
        </div>
      </div>
    </Drawer>
  )
}
