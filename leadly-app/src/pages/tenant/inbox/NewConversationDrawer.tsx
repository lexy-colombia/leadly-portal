import { useEffect, useState } from 'react'
import { listClients, createClient } from '../../../lib/api/clients'
import { createConversation, getConversationWindowStatus } from '../../../lib/api/conversations'
import { listApprovedTemplates, sendTemplateMessage } from '../../../lib/api/templates'
import { listWhatsappLinesByTenant } from '../../../lib/api/whatsappLines'
import type { Client, WhatsappLine, WhatsappMessageTemplate } from '../../../types/domain'
import { FieldError } from '@/components/atoms'
import { Drawer } from '@/components/organisms'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { isNotBlank, isValidE164Phone } from '../../../lib/validation'
import { formatPhoneDisplay } from '../../../lib/phone'
import { PhoneInput } from '@/components/molecules'
import { useLanguage } from '../../../contexts/LanguageContext'

const FIELD_CLASS = '!h-7 !rounded-lg !text-xs'

type Mode = 'existing' | 'new'
type Step = 'form' | 'template'

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

  const [step, setStep] = useState<Step>('form')
  const [pendingContact, setPendingContact] = useState<Client | null>(null)
  const [templates, setTemplates] = useState<WhatsappMessageTemplate[] | null>(null)
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null)
  const [variables, setVariables] = useState<string[]>([])

  useEffect(() => {
    if (!open) return
    setMode('existing')
    setSelectedContactId(null)
    setNewName('')
    setNewPhone('')
    setTouched(false)
    setFormError(null)
    setStep('form')
    setPendingContact(null)
    setTemplates(null)
    setSelectedTemplateId(null)
    setVariables([])
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

  const selectedLine = lines.find((l) => l.id === lineId)
  const selectedTemplate = templates?.find((tpl) => tpl.id === selectedTemplateId) ?? null

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
        // Reflect the new contact as "existing" so going back to this step
        // (e.g. from the template picker) never creates a duplicate contact
        // on a second submit.
        setContacts((prev) => [contact, ...prev])
        setMode('existing')
        setSelectedContactId(contact.id)
      }

      const { windowOpen } = await getConversationWindowStatus(lineId, contact.phone)
      if (windowOpen) {
        const conversation = await createConversation(tenantId, lineId, contact.id, contact.phone, contact.full_name)
        onCreated(conversation.id)
        onClose()
        return
      }

      const approved = await listApprovedTemplates(tenantId)
      setPendingContact(contact)
      setTemplates(approved.filter((tpl) => tpl.business_account_id === selectedLine?.business_account_id))
      setSelectedTemplateId(null)
      setVariables([])
      setStep('template')
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('inbox.newConv.errors.createFailed'))
    } finally {
      setSubmitting(false)
    }
  }

  async function handleSendTemplate() {
    if (!pendingContact || !selectedTemplate) return
    setFormError(null)
    setSubmitting(true)
    try {
      const { conversationId } = await sendTemplateMessage({
        tenant_id: tenantId,
        whatsapp_line_id: lineId,
        contact_id: pendingContact.id,
        contact_phone: pendingContact.phone,
        contact_name: pendingContact.full_name,
        template_id: selectedTemplate.id,
        variables,
      })
      onCreated(conversationId)
      onClose()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('inbox.newConv.errors.createFailed'))
    } finally {
      setSubmitting(false)
    }
  }

  if (step === 'template') {
    return (
      <Drawer open={open} onClose={onClose} title={t('inbox.newConv.title')} description={t('inbox.newConv.windowClosed')}>
        <div className="space-y-4">
          {templates && templates.length === 0 && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">{t('inbox.newConv.noApprovedTemplates')}</p>
          )}

          {templates && templates.length > 0 && (
            <>
              <div>
                <Label htmlFor="new-conv-template">{t('inbox.newConv.templateLabel')}</Label>
                <Select
                  value={selectedTemplateId ?? ''}
                  onValueChange={(v) => {
                    setSelectedTemplateId(v)
                    const tpl = templates.find((t2) => t2.id === v)
                    setVariables(tpl ? Array(tpl.variable_count).fill('') : [])
                  }}
                >
                  <SelectTrigger id="new-conv-template" className={`mt-1 w-full ${FIELD_CLASS}`}>
                    <SelectValue placeholder={t('common.form.selectPlaceholder')} />
                  </SelectTrigger>
                  <SelectContent>
                    {templates.map((tpl) => (
                      <SelectItem key={tpl.id} value={tpl.id} className="text-xs">
                        {tpl.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {selectedTemplate && (
                <>
                  <p className="rounded-lg border border-brand-100 bg-brand-50 px-3 py-2 text-xs text-brand-600">{selectedTemplate.body_text}</p>
                  {Array.from({ length: selectedTemplate.variable_count }).map((_, i) => (
                    <div key={i}>
                      <Label htmlFor={`template-var-${i}`}>{t('inbox.newConv.templateVariable', { n: i + 1 })}</Label>
                      <Input
                        id={`template-var-${i}`}
                        value={variables[i] ?? ''}
                        onChange={(e) =>
                          setVariables((prev) => {
                            const next = [...prev]
                            next[i] = e.target.value
                            return next
                          })
                        }
                        className={`mt-1 ${FIELD_CLASS}`}
                      />
                    </div>
                  ))}
                </>
              )}
            </>
          )}

          {formError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</p>}

          <div className="flex gap-2 border-t border-brand-100 pt-4">
            {templates && templates.length > 0 && (
              <Button
                type="button"
                onClick={handleSendTemplate}
                disabled={submitting || !selectedTemplate || variables.some((v) => !v.trim())}
              >
                {submitting ? t('common.actions.creating') : t('inbox.newConv.sendTemplate')}
              </Button>
            )}
            <Button type="button" variant="ghost" onClick={() => setStep('form')}>
              {t('common.actions.back')}
            </Button>
          </div>
        </div>
      </Drawer>
    )
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
                        <span className="shrink-0 text-brand-400">{formatPhoneDisplay(c.phone)}</span>
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
              <PhoneInput id="new-conv-phone" value={newPhone} onChange={setNewPhone} invalid={!!newPhoneError} placeholder="3001234567" className="mt-1" />
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
