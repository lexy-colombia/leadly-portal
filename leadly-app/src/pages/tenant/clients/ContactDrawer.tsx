import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { createClient, updateClient } from '../../../lib/api/clients'
import { listProfilesByTenant } from '../../../lib/api/users'
import type { ClientStage, Client, Profile } from '../../../types/domain'
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
import { useLanguage } from '../../../contexts/LanguageContext'
import { useAuth } from '../../../contexts/AuthContext'
import type { TranslationKey } from '../../../i18n/translations'

export const STAGE_LABEL: Record<ClientStage, TranslationKey> = {
  lead: 'contacts.stage.lead',
  contactado: 'contacts.stage.contactado',
  negociacion: 'contacts.stage.negociacion',
  cliente: 'contacts.stage.cliente',
  perdido: 'contacts.stage.perdido',
}

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
  const { enabledModules } = useAuth()
  // Same criterion as the Clients list/detail: "etapa" only shows up where
  // the Pipeline module is actually enabled for the tenant -- otherwise
  // it's a field nobody downstream can see or filter by.
  const showStage = enabledModules?.has('pipeline') ?? false
  const [fullName, setFullName] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [company, setCompany] = useState('')
  const [stage, setStage] = useState<ClientStage>('lead')
  const [tags, setTags] = useState<string[]>([])
  const [assignedTo, setAssignedTo] = useState<string | null>(null)
  const [agents, setAgents] = useState<Profile[]>([])
  const [nit, setNit] = useState('')
  const [industry, setIndustry] = useState('')
  const [website, setWebsite] = useState('')
  const [address, setAddress] = useState('')
  const [city, setCity] = useState('')
  const [notes, setNotes] = useState('')
  const [isActive, setIsActive] = useState(true)
  const [creditEnabled, setCreditEnabled] = useState(false)
  const [touched, setTouched] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setFullName(contact?.full_name ?? '')
    setPhone(contact?.phone ?? '')
    setEmail(contact?.email ?? '')
    setCompany(contact?.company ?? '')
    setStage(contact?.stage ?? 'lead')
    setTags(contact?.tags ?? [])
    setAssignedTo(contact?.assigned_to ?? null)
    setNit(contact?.nit ?? '')
    setIndustry(contact?.industry ?? '')
    setWebsite(contact?.website ?? '')
    setAddress(contact?.address ?? '')
    setCity(contact?.city ?? '')
    setNotes(contact?.notes ?? '')
    setIsActive(contact?.is_active ?? true)
    setCreditEnabled(contact?.credit_enabled ?? false)
    setTouched(false)
    setFormError(null)
  }, [open, contact])

  useEffect(() => {
    if (!open) return
    listProfilesByTenant(tenantId).then(setAgents).catch(() => {})
  }, [open, tenantId])

  const nameError = touched && !isNotBlank(fullName) ? t('contacts.drawer.errors.nameRequired') : undefined
  const phoneError = touched && !isValidE164Phone(phone) ? t('contacts.drawer.errors.invalidPhone') : undefined
  const emailError = touched && isNotBlank(email) && !isValidEmail(email) ? t('contacts.drawer.errors.invalidEmail') : undefined

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    setFormError(null)
    if (!isNotBlank(fullName) || !isValidE164Phone(phone) || (isNotBlank(email) && !isValidEmail(email))) return

    setSubmitting(true)
    try {
      const input = {
        tenant_id: tenantId,
        full_name: fullName.trim(),
        phone: phone.trim(),
        email: email.trim() || null,
        company: company.trim() || null,
        stage,
        tags,
        assigned_to: assignedTo,
        nit: nit.trim() || null,
        industry: industry.trim() || null,
        website: website.trim() || null,
        address: address.trim() || null,
        city: city.trim() || null,
        notes: notes.trim() || null,
        is_active: isActive,
        credit_enabled: creditEnabled,
      }
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

        <Section title={t('contacts.drawer.sections.classification')}>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="contact-company">{t('contacts.drawer.fields.company')}</Label>
              <Input
                id="contact-company"
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                placeholder={t('contacts.drawer.fields.companyPlaceholder')}
                className={`mt-1 ${FIELD_CLASS}`}
              />
            </div>
            {showStage ? (
              <div>
                <Label htmlFor="contact-stage">{t('contacts.drawer.fields.stage')}</Label>
                <Select value={stage} onValueChange={(v) => setStage(v as ClientStage)}>
                  <SelectTrigger id="contact-stage" className={`mt-1 w-full ${FIELD_CLASS}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(STAGE_LABEL) as ClientStage[]).map((s) => (
                      <SelectItem key={s} value={s} className="text-xs">
                        {t(STAGE_LABEL[s])}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : (
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
            )}
          </div>

          {showStage && (
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
          )}

          <div>
            <Label htmlFor="contact-tags">{t('contacts.drawer.fields.tags')}</Label>
            <TagInput value={tags} onChange={setTags} placeholder={t('contacts.drawer.fields.tagsPlaceholder')} className="mt-1 !rounded-lg !py-1 text-xs" />
          </div>
        </Section>

        <Section title={t('contacts.drawer.sections.additional')}>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="contact-nit">{t('contacts.drawer.fields.nit')}</Label>
              <Input id="contact-nit" value={nit} onChange={(e) => setNit(e.target.value)} className={`mt-1 ${FIELD_CLASS}`} />
            </div>
            <div>
              <Label htmlFor="contact-industry">{t('contacts.drawer.fields.industry')}</Label>
              <Input id="contact-industry" value={industry} onChange={(e) => setIndustry(e.target.value)} className={`mt-1 ${FIELD_CLASS}`} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="contact-city">{t('contacts.drawer.fields.city')}</Label>
              <Input id="contact-city" value={city} onChange={(e) => setCity(e.target.value)} className={`mt-1 ${FIELD_CLASS}`} />
            </div>
            <div>
              <Label htmlFor="contact-website">{t('contacts.drawer.fields.website')}</Label>
              <Input id="contact-website" value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://" className={`mt-1 ${FIELD_CLASS}`} />
            </div>
          </div>
          <div>
            <Label htmlFor="contact-address">{t('contacts.drawer.fields.address')}</Label>
            <Input id="contact-address" value={address} onChange={(e) => setAddress(e.target.value)} className={`mt-1 ${FIELD_CLASS}`} />
          </div>
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

        {formError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</p>}

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
