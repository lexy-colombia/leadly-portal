import { useEffect, useState } from 'react'
import { listClients, createClient } from '../../../lib/api/clients'
import { createConversation } from '../../../lib/api/conversations'
import { listWhatsappLinesByTenant } from '../../../lib/api/whatsappLines'
import type { Client, WhatsappLine } from '../../../types/domain'
import { FieldError } from '@/components/atoms'
import { Drawer } from '@/components/organisms'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { isNotBlank, isValidE164Phone } from '../../../lib/validation'
import { useLanguage } from '../../../contexts/LanguageContext'

const FIELD_CLASS = '!h-7 !rounded-lg !text-xs'

type Mode = 'existing' | 'new'

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
  const [mode, setMode] = useState<Mode>('existing')
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
      <div className="space-y-4">
        <Tabs value={mode} onValueChange={(v) => setMode(v as Mode)}>
          <TabsList className="w-full">
            <TabsTrigger value="existing" className="text-xs">
              {t('inbox.newConv.existingContact')}
            </TabsTrigger>
            <TabsTrigger value="new" className="text-xs">
              {t('inbox.newConv.newContact')}
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {mode === 'existing' ? (
          <div>
            <div className="overflow-hidden rounded-lg border border-input">
              <Command>
                <CommandInput placeholder={t('inbox.newConv.searchContact')} className="text-xs" />
                <CommandList className="max-h-56">
                  <CommandEmpty className="text-xs">{t('common.status.noResults')}</CommandEmpty>
                  <CommandGroup>
                    {contacts.map((c) => (
                      <CommandItem key={c.id} value={`${c.full_name} ${c.phone}`} onSelect={() => setSelectedContactId(c.id)} className="text-xs">
                        <span className="flex-1 truncate">{c.full_name}</span>
                        <span className="shrink-0 text-brand-400">{c.phone}</span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            </div>
            {selectedContactId && (
              <p className="mt-1.5 text-xs text-brand-500">
                {t('inbox.newConv.selected', { name: contacts.find((c) => c.id === selectedContactId)?.full_name ?? '' })}
              </p>
            )}
            <FieldError message={contactMissingError} />
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <Label htmlFor="new-conv-name">{t('inbox.newConv.fullName')}</Label>
              <Input
                id="new-conv-name"
                value={newName}
                aria-invalid={!!newNameError}
                onChange={(e) => setNewName(e.target.value)}
                placeholder={t('inbox.newConv.fullNamePlaceholder')}
                className={`mt-1 ${FIELD_CLASS}`}
              />
              <FieldError message={newNameError} />
            </div>
            <div>
              <Label htmlFor="new-conv-phone">{t('inbox.newConv.phone')}</Label>
              <Input
                id="new-conv-phone"
                value={newPhone}
                aria-invalid={!!newPhoneError}
                onChange={(e) => setNewPhone(e.target.value)}
                placeholder="+573001234567"
                className={`mt-1 ${FIELD_CLASS}`}
              />
              <FieldError message={newPhoneError} />
            </div>
          </div>
        )}

        <div>
          <Label htmlFor="new-conv-line">{t('inbox.newConv.line')}</Label>
          <Select value={lineId} onValueChange={setLineId} disabled={lines.length === 0}>
            <SelectTrigger id="new-conv-line" className={`mt-1 w-full ${FIELD_CLASS}`}>
              <SelectValue placeholder={t('inbox.newConv.noActiveLines')} />
            </SelectTrigger>
            <SelectContent>
              {lines.map((l) => (
                <SelectItem key={l.id} value={l.id} className="text-xs">
                  {l.display_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {formError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</p>}

        <div className="flex gap-2 border-t border-brand-100 pt-4">
          <Button type="button" onClick={handleSubmit} disabled={submitting}>
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
