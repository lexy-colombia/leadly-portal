import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { CheckIcon, XIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { createCampaign, updateCampaign } from '../../../lib/api/campaigns'
import type { ParsedRecipient } from '../../../lib/api/campaigns'
import { listApprovedTemplates } from '../../../lib/api/templates'
import { listWhatsappLinesByTenant } from '../../../lib/api/whatsappLines'
import { listClients } from '../../../lib/api/clients'
import type { Client, WhatsappLine, WhatsappMessageTemplate } from '../../../types/domain'
import { FieldError } from '@/components/atoms'
import { Drawer } from '@/components/organisms'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { PlusIcon } from '@/components/atoms/icons'
import { useLanguage } from '../../../contexts/LanguageContext'

const FIELD_CLASS = '!h-7 !rounded-lg !text-xs'
const TEXTAREA_CLASS = '!rounded-lg !py-1.5 !text-xs'
const FORM_ID = 'campaign-form'

/** Indicativos para el tab "Número nuevo" -- lista corta a mano, no un
 * catálogo exhaustivo de +200 países, cubre los mercados donde opera la
 * base de tenants hoy. Colombia primero porque es el valor por defecto. */
const DIAL_CODES = [
  { code: '57', label: 'Colombia (+57)' },
  { code: '1', label: 'Estados Unidos (+1)' },
  { code: '52', label: 'México (+52)' },
  { code: '34', label: 'España (+34)' },
  { code: '54', label: 'Argentina (+54)' },
  { code: '56', label: 'Chile (+56)' },
  { code: '51', label: 'Perú (+51)' },
  { code: '593', label: 'Ecuador (+593)' },
  { code: '58', label: 'Venezuela (+58)' },
  { code: '507', label: 'Panamá (+507)' },
  { code: '506', label: 'Costa Rica (+506)' },
]

/** Un destinatario en construcción dentro del drawer -- `key` identifica la
 * fila en la UI: el id del cliente si vino del picker de contactos, o un
 * uuid generado si se agregó a mano (ver tab "Número nuevo"). No hay
 * distinción de origen más allá de esto -- ambos terminan siendo la misma
 * fila de campaign_recipients al enviar. */
export interface RecipientDraft {
  key: string
  contact_phone: string
  contact_name: string
  variables: string[]
}

export interface CampaignFormInitial {
  name: string
  templateId: string | null
  lineId: string | null
  topic: string
  /** Formato de <input type="datetime-local"> en hora local -- ver
   * toDatetimeLocalValue. */
  scheduledAt: string
  recipients: { contact_phone: string; contact_name: string; variables: string[] }[]
}

export function defaultScheduledAt(): string {
  const d = new Date(Date.now() + 60 * 60 * 1000)
  d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0)
  return toDatetimeLocalValue(d.toISOString())
}

export function toDatetimeLocalValue(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function CampaignFormDrawer({
  open,
  onClose,
  tenantId,
  onSaved,
  mode = 'create',
  campaignId,
  initial,
}: {
  open: boolean
  onClose: () => void
  tenantId: string
  onSaved: () => void
  mode?: 'create' | 'edit'
  campaignId?: string
  initial?: CampaignFormInitial | null
}) {
  const { t } = useLanguage()
  const [templates, setTemplates] = useState<WhatsappMessageTemplate[]>([])
  const [lines, setLines] = useState<WhatsappLine[]>([])
  const [clients, setClients] = useState<Client[]>([])
  // Inicializados directamente desde `initial` (lazy init de useState) en vez
  // de con un useEffect que los pisa después del primer render -- el caller
  // (Campaigns.tsx) le pasa un `key` distinto por cada apertura (crear/editar/
  // duplicar una campaña puntual), así que un `initial` nuevo siempre implica
  // una instancia de componente nueva con estado fresco, sin necesidad de
  // sincronizar manualmente ni de un ref para "saltar" el primer efecto.
  const [name, setName] = useState(initial?.name ?? '')
  const [templateId, setTemplateId] = useState(initial?.templateId ?? null)
  const [lineId, setLineId] = useState(initial?.lineId ?? null)
  const [topic, setTopic] = useState(initial?.topic ?? '')
  const [scheduledAt, setScheduledAt] = useState(initial?.scheduledAt ?? defaultScheduledAt())
  const [recipients, setRecipients] = useState<RecipientDraft[]>([])
  const [touched, setTouched] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [manualName, setManualName] = useState('')
  const [manualDialCode, setManualDialCode] = useState(DIAL_CODES[0].code)
  const [manualPhone, setManualPhone] = useState('')
  const [manualError, setManualError] = useState<string | null>(null)

  useEffect(() => {
    listApprovedTemplates(tenantId).then(setTemplates).catch(() => setTemplates([]))
    listWhatsappLinesByTenant(tenantId).then((all) => setLines(all.filter((l) => l.status === 'active'))).catch(() => setLines([]))
    listClients(tenantId)
      .then((all) => {
        setClients(all)
        if (initial) {
          setRecipients(
            initial.recipients.map((r) => {
              const match = all.find((c) => c.phone === r.contact_phone)
              return { key: match?.id ?? crypto.randomUUID(), contact_phone: r.contact_phone, contact_name: r.contact_name, variables: r.variables }
            }),
          )
        }
      })
      .catch(() => setClients([]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId])

  const selectedTemplate = templates.find((tpl) => tpl.id === templateId) ?? null
  const eligibleLines = useMemo(
    () => (selectedTemplate ? lines.filter((l) => l.business_account_id === selectedTemplate.business_account_id) : []),
    [lines, selectedTemplate],
  )
  const variableCount = selectedTemplate?.variable_count ?? 0

  // Auto-selecciona la primera línea elegible cuando cambia la plantilla --
  // lineId ya arranca con el valor correcto desde `initial` (ver arriba), así
  // que este efecto nunca lo pisa mientras siga siendo válido para la lista
  // vigente de líneas elegibles.
  useEffect(() => {
    if (eligibleLines.length === 0) return
    if (lineId && eligibleLines.some((l) => l.id === lineId)) return
    setLineId(eligibleLines[0]?.id ?? null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId, eligibleLines])

  // Si cambia la plantilla (y por lo tanto cuántas variables hacen falta),
  // se resetean los valores ya cargados en vez de dejar filas con la
  // cantidad vieja de columnas -- más simple y menos propenso a errores que
  // tratar de mapear variables de una plantilla a otra.
  useEffect(() => {
    setRecipients((prev) => prev.map((r) => (r.variables.length === variableCount ? r : { ...r, variables: Array(variableCount).fill('') })))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variableCount])

  function toggleClient(client: Client) {
    setRecipients((prev) => {
      const idx = prev.findIndex((r) => r.key === client.id)
      if (idx >= 0) return prev.filter((_, i) => i !== idx)
      return [...prev, { key: client.id, contact_phone: client.phone, contact_name: client.full_name, variables: Array(variableCount).fill('') }]
    })
  }

  function removeRecipient(key: string) {
    setRecipients((prev) => prev.filter((r) => r.key !== key))
  }

  function handleAddManual() {
    const localDigits = manualPhone.trim().replace(/\D/g, '')
    if (!localDigits) {
      setManualError(t('campaigns.newDrawer.errors.manualPhoneRequired'))
      return
    }
    const phone = `${manualDialCode}${localDigits}`
    if (recipients.some((r) => r.contact_phone === phone)) {
      setManualError(t('campaigns.newDrawer.errors.manualDuplicate'))
      return
    }
    setRecipients((prev) => [...prev, { key: crypto.randomUUID(), contact_phone: phone, contact_name: manualName.trim(), variables: Array(variableCount).fill('') }])
    setManualName('')
    setManualPhone('')
    setManualError(null)
  }

  function setVariable(key: string, index: number, value: string) {
    setRecipients((prev) => prev.map((r) => (r.key === key ? { ...r, variables: r.variables.map((v, i) => (i === index ? value : v)) } : r)))
  }

  const recipientPayload: ParsedRecipient[] = recipients.map((r) => ({ contact_phone: r.contact_phone, contact_name: r.contact_name, variables: r.variables }))
  const missingVariables = variableCount > 0 && recipients.some((r) => r.variables.some((v) => !v.trim()))

  const nameError = touched && !name.trim() ? t('campaigns.newDrawer.errors.nameRequired') : undefined
  const templateError = touched && !templateId ? t('campaigns.newDrawer.errors.templateRequired') : undefined
  const lineError = touched && templateId && !lineId ? t('campaigns.newDrawer.errors.noEligibleLine') : undefined
  const scheduledError = touched && new Date(scheduledAt).getTime() <= Date.now() ? t('campaigns.newDrawer.errors.scheduledInPast') : undefined
  const recipientsError = touched && recipients.length === 0 ? t('campaigns.newDrawer.errors.noRecipients') : undefined
  const variablesError = touched && missingVariables ? t('campaigns.newDrawer.errors.missingVariables') : undefined

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    setFormError(null)
    if (!name.trim() || !templateId || !lineId || recipients.length === 0 || missingVariables || new Date(scheduledAt).getTime() <= Date.now()) return

    setSubmitting(true)
    try {
      if (mode === 'edit' && campaignId) {
        await updateCampaign(campaignId, tenantId, {
          name: name.trim(),
          whatsapp_line_id: lineId,
          template_id: templateId,
          topic,
          scheduled_at: new Date(scheduledAt).toISOString(),
          recipients: recipientPayload,
        })
      } else {
        await createCampaign({
          tenant_id: tenantId,
          name: name.trim(),
          whatsapp_line_id: lineId,
          template_id: templateId,
          topic,
          scheduled_at: new Date(scheduledAt).toISOString(),
          recipients: recipientPayload,
        })
      }
      onSaved()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t(mode === 'edit' ? 'campaigns.newDrawer.errors.updateFailed' : 'campaigns.newDrawer.errors.createFailed'))
    } finally {
      setSubmitting(false)
    }
  }

  const isEdit = mode === 'edit'

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={isEdit ? t('campaigns.newDrawer.editTitle') : t('campaigns.newDrawer.title')}
      description={isEdit ? t('campaigns.newDrawer.editDescription') : t('campaigns.newDrawer.description')}
      footer={
        <div className="flex gap-2">
          <Button type="submit" form={FORM_ID} disabled={submitting}>
            {submitting ? t('common.actions.saving') : isEdit ? t('common.actions.saveChanges') : t('campaigns.newDrawer.submit')}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose} disabled={submitting}>
            {t('common.actions.cancel')}
          </Button>
        </div>
      }
    >
      <form id={FORM_ID} onSubmit={handleSubmit} noValidate className="space-y-5">
        <div className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-brand-400">{t('campaigns.newDrawer.sectionSetup')}</h3>
          <div>
            <Label htmlFor="campaign-name">{t('campaigns.newDrawer.nameLabel')}</Label>
            <Input
              id="campaign-name"
              value={name}
              aria-invalid={!!nameError}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('campaigns.newDrawer.namePlaceholder')}
              className={`mt-1 ${FIELD_CLASS}`}
            />
            <FieldError message={nameError} />
          </div>

          <div>
            <Label htmlFor="campaign-template">{t('campaigns.newDrawer.templateLabel')}</Label>
            <Select value={templateId ?? ''} onValueChange={setTemplateId} disabled={templates.length === 0}>
              <SelectTrigger id="campaign-template" className={`mt-1 w-full ${FIELD_CLASS}`}>
                <SelectValue placeholder={templates.length === 0 ? t('campaigns.newDrawer.noTemplates') : t('common.form.selectPlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                {templates.map((tpl) => (
                  <SelectItem key={tpl.id} value={tpl.id} className="text-xs">
                    {tpl.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldError message={templateError} />
          </div>

          {selectedTemplate && (
            <div>
              <Label htmlFor="campaign-line">{t('campaigns.newDrawer.lineLabel')}</Label>
              <Select value={lineId ?? ''} onValueChange={setLineId} disabled={eligibleLines.length === 0}>
                <SelectTrigger id="campaign-line" className={`mt-1 w-full ${FIELD_CLASS}`}>
                  <SelectValue placeholder={t('common.form.selectPlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  {eligibleLines.map((line) => (
                    <SelectItem key={line.id} value={line.id} className="text-xs">
                      {line.display_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldError message={lineError} />
            </div>
          )}
        </div>

        {selectedTemplate && (
          <div className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-brand-400">{t('campaigns.newDrawer.sectionContacts')}</h3>
            <p className="text-xs text-brand-400">{t('campaigns.newDrawer.contactsHint')}</p>

            <div className="flex min-h-7 flex-wrap items-center gap-1.5 rounded-lg border border-input px-1.5 py-1">
              {recipients.map((r) => (
                <Badge key={r.key} variant="secondary" className="gap-1 pr-1 text-xs font-normal">
                  {r.contact_name || r.contact_phone}
                  <button type="button" onClick={() => removeRecipient(r.key)} aria-label={r.contact_name || r.contact_phone} className="rounded-full p-0.5 hover:bg-black/10">
                    <XIcon className="size-3" />
                  </button>
                </Badge>
              ))}
              <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
                <PopoverTrigger asChild>
                  <button type="button" className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
                    <PlusIcon width={12} height={12} />
                    {t('campaigns.newDrawer.addContact')}
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-80 p-0" align="start">
                  <Tabs defaultValue="clients">
                    <TabsList className="m-1.5">
                      <TabsTrigger value="clients" className="text-xs">
                        {t('campaigns.newDrawer.tabClients')}
                      </TabsTrigger>
                      <TabsTrigger value="manual" className="text-xs">
                        {t('campaigns.newDrawer.tabManual')}
                      </TabsTrigger>
                    </TabsList>
                    <TabsContent value="clients" className="mt-0">
                      <Command>
                        <CommandInput placeholder={t('campaigns.newDrawer.searchContacts')} className="text-xs" />
                        <CommandList className="max-h-56">
                          <CommandEmpty className="text-xs">{t('common.status.noResults')}</CommandEmpty>
                          <CommandGroup>
                            {clients.map((c) => {
                              const checked = recipients.some((r) => r.key === c.id)
                              return (
                                <CommandItem key={c.id} value={`${c.full_name} ${c.phone}`} onSelect={() => toggleClient(c)} className="text-xs">
                                  <span className={cn('flex size-3.5 shrink-0 items-center justify-center rounded-sm border', checked ? 'border-primary bg-primary text-primary-foreground' : 'border-input')}>
                                    {checked && <CheckIcon className="size-2.5" />}
                                  </span>
                                  <span className="flex-1 truncate">{c.full_name}</span>
                                  <span className="shrink-0 text-brand-400">{c.phone}</span>
                                </CommandItem>
                              )
                            })}
                          </CommandGroup>
                        </CommandList>
                      </Command>
                    </TabsContent>
                    <TabsContent value="manual" className="space-y-2 p-3">
                      <div>
                        <Label htmlFor="manual-name" className="text-xs">
                          {t('campaigns.newDrawer.manualNameLabel')}
                        </Label>
                        <Input id="manual-name" value={manualName} onChange={(e) => setManualName(e.target.value)} className={`mt-1 ${FIELD_CLASS}`} />
                      </div>
                      <div>
                        <Label htmlFor="manual-phone" className="text-xs">
                          {t('campaigns.newDrawer.manualPhoneLabel')}
                        </Label>
                        <div className="mt-1 flex gap-1.5">
                          <Select value={manualDialCode} onValueChange={setManualDialCode}>
                            <SelectTrigger id="manual-dial-code" className={`w-24 shrink-0 ${FIELD_CLASS}`}>
                              <SelectValue>{`+${manualDialCode}`}</SelectValue>
                            </SelectTrigger>
                            <SelectContent>
                              {DIAL_CODES.map((c) => (
                                <SelectItem key={c.code} value={c.code} className="text-xs">
                                  {c.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <Input
                            id="manual-phone"
                            value={manualPhone}
                            onChange={(e) => setManualPhone(e.target.value)}
                            placeholder={t('campaigns.newDrawer.manualPhonePlaceholder')}
                            className={FIELD_CLASS}
                          />
                        </div>
                      </div>
                      {manualError && <p className="text-xs text-red-600">{manualError}</p>}
                      <Button type="button" size="sm" className="w-full" onClick={handleAddManual}>
                        {t('campaigns.newDrawer.manualAdd')}
                      </Button>
                    </TabsContent>
                  </Tabs>
                </PopoverContent>
              </Popover>
            </div>
            <FieldError message={recipientsError} />

            {recipients.length > 0 && variableCount > 0 && (
              <div className="overflow-hidden rounded-2xl border border-brand-100 bg-white">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('campaigns.newDrawer.tableContact')}</TableHead>
                      {Array.from({ length: variableCount }).map((_, i) => (
                        <TableHead key={i}>{t('campaigns.newDrawer.tableVariable', { n: i + 1 })}</TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {recipients.map((r) => (
                      <TableRow key={r.key}>
                        <TableCell className="text-xs font-medium text-brand-800">{r.contact_name || r.contact_phone}</TableCell>
                        {Array.from({ length: variableCount }).map((_, i) => (
                          <TableCell key={i}>
                            <Input value={r.variables[i] ?? ''} onChange={(e) => setVariable(r.key, i, e.target.value)} className={FIELD_CLASS} />
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
            <FieldError message={variablesError} />
          </div>
        )}

        <div className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-brand-400">{t('campaigns.newDrawer.sectionSchedule')}</h3>
          <div>
            <Label htmlFor="campaign-topic">{t('campaigns.newDrawer.topicLabel')}</Label>
            <Textarea
              id="campaign-topic"
              rows={3}
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder={t('campaigns.newDrawer.topicPlaceholder')}
              className={`mt-1 ${TEXTAREA_CLASS}`}
            />
            <p className="mt-1 text-xs text-brand-400">{t('campaigns.newDrawer.topicHint')}</p>
          </div>
          <div>
            <Label htmlFor="campaign-scheduled">{t('campaigns.newDrawer.scheduledLabel')}</Label>
            <Input
              id="campaign-scheduled"
              type="datetime-local"
              value={scheduledAt}
              aria-invalid={!!scheduledError}
              onChange={(e) => setScheduledAt(e.target.value)}
              className={`mt-1 ${FIELD_CLASS}`}
            />
            <FieldError message={scheduledError} />
          </div>
        </div>

        {formError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</p>}
      </form>
    </Drawer>
  )
}
