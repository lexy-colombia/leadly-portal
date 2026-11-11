import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { createClient, updateClient, dianDocumentTypeCodeToGeneric } from '../../../lib/api/clients'
import { listProfilesByTenant } from '../../../lib/api/users'
import { listCustomFieldDefinitions } from '../../../lib/api/customFields'
import { inputToPayload, payloadToInput } from '../../../lib/customFieldValues'
import { BillingProfileFields } from './BillingProfileFields'
import { CustomFieldInput } from './CustomFieldInput'
import type { Client, ClientBillingProfile, CustomFieldDefinition, Profile } from '../../../types/domain'
import { FieldError } from '@/components/atoms'
import { ComboboxFilter, PhoneInput, TagInput } from '@/components/molecules'
import { Drawer } from '@/components/organisms'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { isNotBlank, isValidE164Phone, isValidEmail } from '../../../lib/validation'
import { combinePhone, splitPhone } from '../../../lib/phone'
import { useLanguage } from '../../../contexts/LanguageContext'
import { listDianDocumentTypes } from '../../../lib/api/tenantDianProfile'
import type { DianDocumentType } from '../../../types/domain'

// Same compact sizing as ProductDrawer/CategoryDrawer -- every field in this
// form is pinned to it so it doesn't feel like a visually separate, bigger
// design system from the rest of the app.
const FIELD_CLASS = '!h-7 !rounded-lg !text-xs'
const TEXTAREA_CLASS = '!rounded-lg !py-1.5 !text-xs'
const COMBOBOX_TRIGGER_CLASS = 'flex-1 !rounded-lg'

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-2.5">
      <p className="text-[11px] font-semibold tracking-wide text-brand-400 uppercase">{title}</p>
      {children}
    </div>
  )
}

export function ContactDrawer({
  open,
  onClose,
  tenantId,
  contact,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  tenantId: string
  /** Present when editing an existing contact; omitted when creating a new one. */
  contact?: Client | null
  onSaved: (contact: Client) => void
}) {
  const { t } = useLanguage()
  const [billingProfile, setBillingProfile] = useState<ClientBillingProfile>({})
  const [fullName, setFullName] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [assignedTo, setAssignedTo] = useState<string | null>(null)
  const [agents, setAgents] = useState<Profile[]>([])
  const [documentNumber, setDocumentNumber] = useState('')
  const [country, setCountry] = useState('')
  const [notes, setNotes] = useState('')
  const [isActive, setIsActive] = useState(true)
  const [creditEnabled, setCreditEnabled] = useState(false)
  const [dianDocumentTypeCode, setDianDocumentTypeCode] = useState('')
  const [appliesWithholding, setAppliesWithholding] = useState(false)
  const [dianDocumentTypes, setDianDocumentTypes] = useState<DianDocumentType[]>([])
  const [customDefs, setCustomDefs] = useState<CustomFieldDefinition[]>([])
  const [customValues, setCustomValues] = useState<Record<string, string | boolean | undefined>>({})
  const [touched, setTouched] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setBillingProfile(contact?.billing_profile ?? {})
    setFullName(contact?.full_name ?? '')
    // clients.phone_prefix/phone quedaron separados en la base
    // (20260904000000_clients_phone_prefix_split.sql) -- PhoneInput sigue
    // trabajando con un solo string combinado (mismo contrato de siempre,
    // no se tocó ese componente), así que se recombinan acá para precargar
    // el formulario, y se vuelven a separar al armar el payload (ver
    // handleSubmit).
    setPhone(contact ? combinePhone(contact.phone_prefix, contact.phone) : '')
    setEmail(contact?.email ?? '')
    setTags(contact?.tags ?? [])
    setAssignedTo(contact?.assigned_to ?? null)
    setDocumentNumber(contact?.document_number ?? '')
    setCountry(contact?.billing_profile?.address?.country ?? contact?.country ?? '')
    setNotes(contact?.notes ?? '')
    setIsActive(contact?.is_active ?? true)
    setCreditEnabled(contact?.credit_enabled ?? false)
    setDianDocumentTypeCode(contact?.dian_document_type_code ?? '')
    setAppliesWithholding(contact?.applies_withholding ?? false)
    setTouched(false)
    setFormError(null)
  }, [open, contact])

  useEffect(() => {
    if (!open) return
    listProfilesByTenant(tenantId).then(setAgents).catch(() => {})
    listDianDocumentTypes().then(setDianDocumentTypes).catch(() => {})
    listCustomFieldDefinitions(tenantId, 'client').then(setCustomDefs).catch(() => {})
  }, [open, tenantId])

  // Los valores se precargan cuando están las definiciones (el tipo decide
  // cómo se pinta cada uno) y al abrir/cambiar de cliente.
  useEffect(() => {
    if (!open) return
    const next: Record<string, string | boolean | undefined> = {}
    for (const def of customDefs) next[def.id] = payloadToInput(def.field_type, contact?.custom_fields?.[def.id])
    setCustomValues(next)
  }, [open, contact, customDefs])

  const nameError = touched && !isNotBlank(fullName) ? t('contacts.drawer.errors.nameRequired') : undefined
  const phoneError = touched && !isValidE164Phone(phone) ? t('contacts.drawer.errors.invalidPhone') : undefined
  const emailError = touched && isNotBlank(email) && !isValidEmail(email) ? t('contacts.drawer.errors.invalidEmail') : undefined

  const documentOptions = dianDocumentTypes.map(({ code, name }) => ({
    code,
    label: name,
    organizationType: code === '31' || code === '50' ? '1' as const : '2' as const,
  }))
  const selectedDocument = documentOptions.find((option) => option.code === dianDocumentTypeCode)

  function selectDocument(code: string) {
    const option = documentOptions.find((item) => item.code === code)
    if (!option) return
    setDianDocumentTypeCode(option.code)
    setBillingProfile((profile) => ({ ...profile, organization_type: option.organizationType }))
  }

  /** Devuelve el objeto a enviar, o null si NO debe enviarse la clave:
   * sin definiciones activas, o sin cambios respecto de lo guardado (en
   * crear: sin ningún valor). Así un guardado normal de cliente no toca la
   * columna custom_fields. */
  function buildCustomFields(): Record<string, unknown> | null {
    if (customDefs.length === 0) return null
    const current = contact?.custom_fields ?? {}
    const next: Record<string, unknown> = { ...current }
    for (const def of customDefs) {
      const payload = inputToPayload(def.field_type, customValues[def.id])
      if (payload === null) delete next[def.id]
      else next[def.id] = payload
    }
    const keys = new Set([...Object.keys(current), ...Object.keys(next)])
    const changed = [...keys].some((k) => JSON.stringify(current[k]) !== JSON.stringify(next[k]))
    return changed ? next : null
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    setFormError(null)
    if (!isNotBlank(fullName) || !isValidE164Phone(phone) || (isNotBlank(email) && !isValidEmail(email))) return

    if (billingProfile.email?.trim() && !isValidEmail(billingProfile.email.trim())) {
      setFormError(t('contacts.billing.invalidEmail'))
      return
    }
    setSubmitting(true)
    try {
      const { dialCode, localNumber } = splitPhone(phone)
      const input = {
        tenant_id: tenantId,
        full_name: fullName.trim(),
        phone_prefix: dialCode,
        phone: localNumber,
        email: email.trim() || null,
        tags,
        assigned_to: assignedTo,
        // `document_type` (lista genérica NIT/CC/CE/RUC/RFC/PASAPORTE/OTRO)
        // ya no se le pide al usuario por separado -- pedido explícito del
        // usuario 2026-09-09: "se piden tipos de documentos y números de
        // documentos varias veces". Se sigue escribiendo, derivado del
        // tipo de documento DIAN elegido (la única fuente real ahora), para
        // que ClientPickerCard.tsx/PosReceiptTicket.tsx (que lo muestran
        // como etiqueta corta en tickets/buscadores) no se queden sin dato.
        document_type: dianDocumentTypeCodeToGeneric(dianDocumentTypeCode || null),
        document_number: documentNumber.trim() || null,
        country: country || null,
        notes: notes.trim() || null,
        is_active: isActive,
        credit_enabled: creditEnabled,
        dian_document_type_code: dianDocumentTypeCode || null,
        applies_withholding: appliesWithholding,
        ...(contact?.is_walk_in ? {} : {
          billing_profile: {
            organization_type: selectedDocument?.organizationType ?? billingProfile.organization_type ?? null,
            tax_level_code: billingProfile.tax_level_code ?? null,
            tax_scheme_code: billingProfile.tax_scheme_code ?? null,
            legal_name: billingProfile.legal_name?.trim() || null,
            email: billingProfile.email?.trim() || null,
            address: billingProfile.address && (billingProfile.address.line1?.trim() || billingProfile.address.city || billingProfile.address.state_province)
              ? { ...billingProfile.address, country: country || null, line1: billingProfile.address.line1?.trim() || null }
              : null,
          },
        }),
        // Se parte de lo ya guardado (incluye valores de campos hoy
        // inactivos, que no se tocan) y se pisan solo los campos activos
        // del formulario; vacío = se quita la clave. La validación la hace
        // el trigger de la base y su mensaje se muestra tal cual.
      }
      const customFields = buildCustomFields()
      if (customFields) Object.assign(input, { custom_fields: customFields })
      const saved = contact ? await updateClient(contact.id, input) : await createClient(input)
      onSaved(saved)
      onClose()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('contacts.drawer.errors.saveFailed'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={contact ? t('contacts.drawer.editTitle') : t('contacts.drawer.newTitle')}
      description={t('contacts.drawer.description')}
      size="lg"
    >
      <form onSubmit={handleSubmit} noValidate className="space-y-5">
        <Section title={t('contacts.drawer.sections.basics')}>
          <div>
            <Label htmlFor="contact-name">{t('contacts.drawer.fields.fullName')}</Label>
            <Input
              id="contact-name"
              value={fullName}
              aria-invalid={!!nameError}
              onChange={(e) => setFullName(e.target.value)}
              placeholder={t('contacts.drawer.fields.fullNamePlaceholder')}
              className={`mt-1 ${FIELD_CLASS}`}
            />
            <FieldError message={nameError} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="contact-phone">{t('contacts.drawer.fields.phone')}</Label>
              <PhoneInput id="contact-phone" value={phone} onChange={setPhone} placeholder="3001234567" invalid={!!phoneError} className="mt-1" />
              <FieldError message={phoneError} />
            </div>
            <div>
              <Label htmlFor="contact-email">{t('contacts.drawer.fields.email')}</Label>
              <Input
                id="contact-email"
                type="email"
                value={email}
                aria-invalid={!!emailError}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t('contacts.drawer.fields.emailPlaceholder')}
                className={`mt-1 ${FIELD_CLASS}`}
              />
              <FieldError message={emailError} />
            </div>
          </div>
        </Section>

        <Section title={t('contacts.drawer.sections.einvoicing')}>
          {contact?.is_walk_in && <p className="text-xs text-muted-foreground">{t('contacts.billing.walkInHint')}</p>}
          <fieldset disabled={contact?.is_walk_in} className="min-w-0 space-y-2.5">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="contact-dian-document-type">{t('contacts.drawer.fields.dianDocumentType')}</Label>
                <Select value={dianDocumentTypeCode} onValueChange={selectDocument} disabled={contact?.is_walk_in}>
                  <SelectTrigger id="contact-dian-document-type" className={`mt-1 w-full ${FIELD_CLASS}`}>
                    <SelectValue placeholder={t('common.form.selectPlaceholder')}>
                      {selectedDocument?.label}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {documentOptions.map((option) => (
                      <SelectItem key={option.code} value={option.code}>{option.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="contact-document-number">{t('contacts.drawer.fields.documentNumber')}</Label>
                <Input id="contact-document-number" value={documentNumber} onChange={(e) => setDocumentNumber(e.target.value)} className={`mt-1 ${FIELD_CLASS}`} />
              </div>
            </div>
            <BillingProfileFields profile={billingProfile} onChange={setBillingProfile} country={country} onCountryChange={setCountry} disabled={contact?.is_walk_in} />
            <div className="flex items-center justify-between rounded-lg border border-brand-100 px-3 py-2.5">
              <div>
                <Label htmlFor="contact-withholding" className="font-normal text-brand-700">
                  {t('contacts.drawer.fields.appliesWithholding')}
                </Label>
                <p className="mt-0.5 text-[11px] text-brand-400">{t('contacts.drawer.fields.appliesWithholdingHint')}</p>
              </div>
              <Switch id="contact-withholding" checked={appliesWithholding} onCheckedChange={setAppliesWithholding} disabled={contact?.is_walk_in} />
            </div>
          </fieldset>
        </Section>

        <Section title={t('contacts.drawer.sections.classification')}>
          <div>
            <Label>{t('contacts.drawer.fields.assignedAgent')}</Label>
            <div className="mt-1">
              <ComboboxFilter
                options={agents.map((a) => ({ id: a.id, label: a.full_name }))}
                value={assignedTo}
                onChange={setAssignedTo}
                placeholder={t('contacts.drawer.fields.unassigned')}
                searchPlaceholder={t('contacts.filters.agent.search')}
                emptyLabel={t('contacts.filters.agent.noResults')}
                className="w-full"
                triggerClassName={COMBOBOX_TRIGGER_CLASS}
              />
            </div>
          </div>

          <div>
            <Label htmlFor="contact-tags">{t('contacts.drawer.fields.tags')}</Label>
            <TagInput value={tags} onChange={setTags} placeholder={t('contacts.drawer.fields.tagsPlaceholder')} className="mt-1 !rounded-lg !py-1 text-xs" />
          </div>
        </Section>

        <Section title={t('contacts.drawer.sections.additional')}>
          <div>
            <Label htmlFor="contact-notes">{t('contacts.drawer.fields.notes')}</Label>
            <Textarea id="contact-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={`mt-1 ${TEXTAREA_CLASS}`} />
          </div>
          <div className="flex items-center justify-between rounded-lg border border-brand-100 px-3 py-2.5">
            <Label htmlFor="contact-active" className="font-normal text-brand-700">
              {t('contacts.drawer.fields.active')}
            </Label>
            <Switch id="contact-active" checked={isActive} onCheckedChange={setIsActive} />
          </div>
          <div className="flex items-center justify-between rounded-lg border border-brand-100 px-3 py-2.5">
            <div>
              <Label htmlFor="contact-credit" className="font-normal text-brand-700">
                {t('contacts.drawer.fields.creditEnabled')}
              </Label>
              <p className="mt-0.5 text-[11px] text-brand-400">{t('contacts.drawer.fields.creditEnabledHint')}</p>
            </div>
            <Switch id="contact-credit" checked={creditEnabled} onCheckedChange={setCreditEnabled} />
          </div>
        </Section>

        {customDefs.length > 0 && (
          <Section title={t('contacts.customFields.section')}>
            <div className="grid grid-cols-2 gap-3">
              {customDefs.map((def) => (
                <CustomFieldInput
                  key={def.id}
                  definition={def}
                  value={customValues[def.id]}
                  onChange={(v) => setCustomValues((prev) => ({ ...prev, [def.id]: v }))}
                />
              ))}
            </div>
          </Section>
        )}

        {formError && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{formError}</p>}

        <div className="flex gap-2 border-t border-brand-100 pt-4">
          <Button type="submit" disabled={submitting}>
            {submitting ? t('common.actions.saving') : t('common.actions.save')}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('common.actions.cancel')}
          </Button>
        </div>
      </form>
    </Drawer>
  )
}
