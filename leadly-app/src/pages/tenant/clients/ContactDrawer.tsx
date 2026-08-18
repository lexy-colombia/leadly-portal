import { useEffect, useState, type FormEvent } from 'react'
import { createClient, updateClient } from '../../../lib/api/clients'
import { listProfilesByTenant } from '../../../lib/api/users'
import type { ClientStage, Client, Profile } from '../../../types/domain'
import { Button, FieldError, Input, Label, Select, Switch, Textarea } from '@/components/atoms'
import { TagInput } from '@/components/molecules'
import { Drawer } from '@/components/organisms'
import { isNotBlank, isValidE164Phone, isValidEmail } from '../../../lib/validation'
import { useLanguage } from '../../../contexts/LanguageContext'
import type { TranslationKey } from '../../../i18n/translations'

export const STAGE_LABEL: Record<ClientStage, TranslationKey> = {
  lead: 'contacts.stage.lead',
  contactado: 'contacts.stage.contactado',
  negociacion: 'contacts.stage.negociacion',
  cliente: 'contacts.stage.cliente',
  perdido: 'contacts.stage.perdido',
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
  const [fullName, setFullName] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [company, setCompany] = useState('')
  const [stage, setStage] = useState<ClientStage>('lead')
  const [tags, setTags] = useState<string[]>([])
  const [assignedTo, setAssignedTo] = useState('')
  const [agents, setAgents] = useState<Profile[]>([])
  const [nit, setNit] = useState('')
  const [industry, setIndustry] = useState('')
  const [website, setWebsite] = useState('')
  const [address, setAddress] = useState('')
  const [city, setCity] = useState('')
  const [notes, setNotes] = useState('')
  const [isActive, setIsActive] = useState(true)
  const [detailsOpen, setDetailsOpen] = useState(false)
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
    setAssignedTo(contact?.assigned_to ?? '')
    setNit(contact?.nit ?? '')
    setIndustry(contact?.industry ?? '')
    setWebsite(contact?.website ?? '')
    setAddress(contact?.address ?? '')
    setCity(contact?.city ?? '')
    setNotes(contact?.notes ?? '')
    setIsActive(contact?.is_active ?? true)
    setDetailsOpen(false)
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
        assigned_to: assignedTo || null,
        nit: nit.trim() || null,
        industry: industry.trim() || null,
        website: website.trim() || null,
        address: address.trim() || null,
        city: city.trim() || null,
        notes: notes.trim() || null,
        is_active: isActive,
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
    >
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        <div>
          <Label htmlFor="contact-name">{t('contacts.drawer.fields.fullName')}</Label>
          <Input
            id="contact-name"
            value={fullName}
            invalid={!!nameError}
            onChange={(e) => setFullName(e.target.value)}
            placeholder={t('contacts.drawer.fields.fullNamePlaceholder')}
          />
          <FieldError message={nameError} />
        </div>

        <div>
          <Label htmlFor="contact-phone">{t('contacts.drawer.fields.phone')}</Label>
          <Input id="contact-phone" value={phone} invalid={!!phoneError} onChange={(e) => setPhone(e.target.value)} placeholder="+573001234567" />
          <FieldError message={phoneError} />
        </div>

        <div>
          <Label htmlFor="contact-email">{t('contacts.drawer.fields.email')}</Label>
          <Input
            id="contact-email"
            type="email"
            value={email}
            invalid={!!emailError}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t('contacts.drawer.fields.emailPlaceholder')}
          />
          <FieldError message={emailError} />
        </div>

        <div>
          <Label htmlFor="contact-company">{t('contacts.drawer.fields.company')}</Label>
          <Input
            id="contact-company"
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            placeholder={t('contacts.drawer.fields.companyPlaceholder')}
          />
        </div>

        <div>
          <Label htmlFor="contact-stage">{t('contacts.drawer.fields.stage')}</Label>
          <Select id="contact-stage" value={stage} onChange={(e) => setStage(e.target.value as ClientStage)}>
            {(Object.keys(STAGE_LABEL) as ClientStage[]).map((s) => (
              <option key={s} value={s}>
                {t(STAGE_LABEL[s])}
              </option>
            ))}
          </Select>
        </div>

        <div>
          <Label htmlFor="contact-tags">{t('contacts.drawer.fields.tags')}</Label>
          <TagInput value={tags} onChange={setTags} placeholder={t('contacts.drawer.fields.tagsPlaceholder')} />
        </div>

        <div>
          <Label htmlFor="contact-assigned">{t('contacts.drawer.fields.assignedAgent')}</Label>
          <Select id="contact-assigned" value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)}>
            <option value="">{t('contacts.drawer.fields.unassigned')}</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.full_name}
              </option>
            ))}
          </Select>
        </div>

        <div className="border-t border-brand-100 pt-4">
          <button type="button" onClick={() => setDetailsOpen((o) => !o)} className="text-xs font-medium text-accent-600 hover:underline">
            {detailsOpen ? t('contacts.drawer.hideDetails') : t('contacts.drawer.showDetails')}
          </button>
        </div>

        {detailsOpen && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="contact-nit">{t('contacts.drawer.fields.nit')}</Label>
                <Input id="contact-nit" value={nit} onChange={(e) => setNit(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="contact-industry">{t('contacts.drawer.fields.industry')}</Label>
                <Input id="contact-industry" value={industry} onChange={(e) => setIndustry(e.target.value)} />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="contact-city">{t('contacts.drawer.fields.city')}</Label>
                <Input id="contact-city" value={city} onChange={(e) => setCity(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="contact-website">{t('contacts.drawer.fields.website')}</Label>
                <Input id="contact-website" value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://" />
              </div>
            </div>

            <div>
              <Label htmlFor="contact-address">{t('contacts.drawer.fields.address')}</Label>
              <Input id="contact-address" value={address} onChange={(e) => setAddress(e.target.value)} />
            </div>

            <div>
              <Label htmlFor="contact-notes">{t('contacts.drawer.fields.notes')}</Label>
              <Textarea id="contact-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
            </div>

            <div className="flex items-center justify-between rounded-lg border border-brand-100 px-3 py-2.5">
              <span className="text-sm text-brand-700">{t('contacts.drawer.fields.active')}</span>
              <Switch checked={isActive} onChange={setIsActive} />
            </div>
          </div>
        )}

        {formError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</p>}

        <div className="flex gap-2 border-t border-brand-100 pt-5">
          <Button type="submit" variant="secondary" disabled={submitting}>
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
