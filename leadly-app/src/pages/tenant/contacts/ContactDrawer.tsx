import { useEffect, useState, type FormEvent } from 'react'
import { createContact, updateContact } from '../../../lib/api/contacts'
import { listProfilesByTenant } from '../../../lib/api/users'
import type { ContactStage, CrmContact, Profile } from '../../../types/domain'
import { Button, Drawer, FieldError, Input, Label, Select, Switch, TagInput, Textarea } from '../../../components/ui'
import { isNotBlank, isValidE164Phone, isValidEmail } from '../../../lib/validation'

export const STAGE_LABEL: Record<ContactStage, string> = {
  lead: 'Lead',
  contactado: 'Contactado',
  negociacion: 'Negociación',
  cliente: 'Cliente',
  perdido: 'Perdido',
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
  contact?: CrmContact | null
  onSaved: (contact: CrmContact) => void
}) {
  const [fullName, setFullName] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [company, setCompany] = useState('')
  const [stage, setStage] = useState<ContactStage>('lead')
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

  const nameError = touched && !isNotBlank(fullName) ? 'El nombre es obligatorio.' : undefined
  const phoneError = touched && !isValidE164Phone(phone) ? 'Teléfono inválido (formato internacional, ej. +573001234567).' : undefined
  const emailError = touched && isNotBlank(email) && !isValidEmail(email) ? 'Correo inválido.' : undefined

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
      const saved = contact ? await updateContact(contact.id, input) : await createContact(input)
      onSaved(saved)
      onClose()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'No se pudo guardar el contacto.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={contact ? 'Editar contacto' : 'Nuevo contacto'}
      description="Información de contacto para tu CRM."
    >
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        <div>
          <Label htmlFor="contact-name">Nombre completo</Label>
          <Input id="contact-name" value={fullName} invalid={!!nameError} onChange={(e) => setFullName(e.target.value)} placeholder="Nombre y apellido" />
          <FieldError message={nameError} />
        </div>

        <div>
          <Label htmlFor="contact-phone">Teléfono (WhatsApp)</Label>
          <Input id="contact-phone" value={phone} invalid={!!phoneError} onChange={(e) => setPhone(e.target.value)} placeholder="+573001234567" />
          <FieldError message={phoneError} />
        </div>

        <div>
          <Label htmlFor="contact-email">Correo (opcional)</Label>
          <Input id="contact-email" type="email" value={email} invalid={!!emailError} onChange={(e) => setEmail(e.target.value)} placeholder="cliente@empresa.com" />
          <FieldError message={emailError} />
        </div>

        <div>
          <Label htmlFor="contact-company">Empresa (opcional)</Label>
          <Input id="contact-company" value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Nombre de la empresa que representa" />
        </div>

        <div>
          <Label htmlFor="contact-stage">Etapa</Label>
          <Select id="contact-stage" value={stage} onChange={(e) => setStage(e.target.value as ContactStage)}>
            {(Object.keys(STAGE_LABEL) as ContactStage[]).map((s) => (
              <option key={s} value={s}>
                {STAGE_LABEL[s]}
              </option>
            ))}
          </Select>
        </div>

        <div>
          <Label htmlFor="contact-tags">Etiquetas</Label>
          <TagInput value={tags} onChange={setTags} placeholder="Escribe y presiona Enter..." />
        </div>

        <div>
          <Label htmlFor="contact-assigned">Agente asignado (opcional)</Label>
          <Select id="contact-assigned" value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)}>
            <option value="">Sin asignar</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.full_name}
              </option>
            ))}
          </Select>
        </div>

        <div className="border-t border-brand-100 pt-4">
          <button type="button" onClick={() => setDetailsOpen((o) => !o)} className="text-xs font-medium text-accent-600 hover:underline">
            {detailsOpen ? 'Ocultar detalles adicionales' : 'Mostrar detalles adicionales (NIT, industria, dirección...)'}
          </button>
        </div>

        {detailsOpen && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="contact-nit">NIT / documento (opcional)</Label>
                <Input id="contact-nit" value={nit} onChange={(e) => setNit(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="contact-industry">Industria (opcional)</Label>
                <Input id="contact-industry" value={industry} onChange={(e) => setIndustry(e.target.value)} />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="contact-city">Ciudad (opcional)</Label>
                <Input id="contact-city" value={city} onChange={(e) => setCity(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="contact-website">Sitio web (opcional)</Label>
                <Input id="contact-website" value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://" />
              </div>
            </div>

            <div>
              <Label htmlFor="contact-address">Dirección (opcional)</Label>
              <Input id="contact-address" value={address} onChange={(e) => setAddress(e.target.value)} />
            </div>

            <div>
              <Label htmlFor="contact-notes">Notas internas (opcional)</Label>
              <Textarea id="contact-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
            </div>

            <div className="flex items-center justify-between rounded-lg border border-brand-100 px-3 py-2.5">
              <span className="text-sm text-brand-700">Contacto activo</span>
              <Switch checked={isActive} onChange={setIsActive} />
            </div>
          </div>
        )}

        {formError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</p>}

        <div className="flex gap-2 border-t border-brand-100 pt-5">
          <Button type="submit" variant="secondary" disabled={submitting}>
            {submitting ? 'Guardando…' : 'Guardar'}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
        </div>
      </form>
    </Drawer>
  )
}
