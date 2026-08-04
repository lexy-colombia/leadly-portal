import { useEffect, useState, type FormEvent } from 'react'
import { createContact, updateContact } from '../../../lib/api/contacts'
import type { ContactStage, CrmContact } from '../../../types/domain'
import { Button, Drawer, FieldError, Input, Label, Select, TagInput } from '../../../components/ui'
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
    setTouched(false)
    setFormError(null)
  }, [open, contact])

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
      }
      const saved = contact ? await updateContact(contact.id, input) : await createContact(input)
      onSaved(saved)
      onClose()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'No se pudo guardar el cliente.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={contact ? 'Editar cliente' : 'Nuevo cliente'}
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
          <Input id="contact-company" value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Nombre de la empresa" />
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
