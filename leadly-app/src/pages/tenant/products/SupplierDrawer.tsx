import { useEffect, useState, type FormEvent } from 'react'
import { createSupplier, updateSupplier } from '../../../lib/api/suppliers'
import type { CrmSupplier } from '../../../types/domain'
import { Button, Drawer, FieldError, Input, Label, Switch, Textarea } from '../../../components/ui'
import { isNotBlank } from '../../../lib/validation'

export function SupplierDrawer({
  open,
  onClose,
  tenantId,
  supplier,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  tenantId: string
  supplier?: CrmSupplier | null
  onSaved: () => void
}) {
  const [name, setName] = useState('')
  const [contactName, setContactName] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [notes, setNotes] = useState('')
  const [isActive, setIsActive] = useState(true)
  const [touched, setTouched] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setName(supplier?.name ?? '')
    setContactName(supplier?.contact_name ?? '')
    setPhone(supplier?.phone ?? '')
    setEmail(supplier?.email ?? '')
    setNotes(supplier?.notes ?? '')
    setIsActive(supplier?.is_active ?? true)
    setTouched(false)
    setFormError(null)
  }, [open, supplier])

  const nameError = touched && !isNotBlank(name) ? 'El nombre es obligatorio.' : undefined

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    setFormError(null)
    if (!isNotBlank(name)) return

    setSubmitting(true)
    try {
      const input = {
        tenant_id: tenantId,
        name: name.trim(),
        contact_name: contactName.trim() || null,
        phone: phone.trim() || null,
        email: email.trim() || null,
        notes: notes.trim() || null,
        is_active: isActive,
      }
      if (supplier) await updateSupplier(supplier.id, input)
      else await createSupplier(input)
      onSaved()
      onClose()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'No se pudo guardar el proveedor.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Drawer open={open} onClose={onClose} title={supplier ? 'Editar proveedor' : 'Nuevo proveedor'} description="A quién le comprás tus productos.">
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        <div>
          <Label htmlFor="supplier-name">Nombre</Label>
          <Input id="supplier-name" value={name} invalid={!!nameError} onChange={(e) => setName(e.target.value)} placeholder="Ej. Textiles del Valle" />
          <FieldError message={nameError} />
        </div>

        <div>
          <Label htmlFor="supplier-contact">Persona de contacto (opcional)</Label>
          <Input id="supplier-contact" value={contactName} onChange={(e) => setContactName(e.target.value)} />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="supplier-phone">Teléfono (opcional)</Label>
            <Input id="supplier-phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="supplier-email">Correo (opcional)</Label>
            <Input id="supplier-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
        </div>

        <div>
          <Label htmlFor="supplier-notes">Notas (opcional)</Label>
          <Textarea id="supplier-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>

        <div className="flex items-center justify-between rounded-lg border border-brand-100 px-3 py-2.5">
          <span className="text-sm text-brand-700">Proveedor activo</span>
          <Switch checked={isActive} onChange={setIsActive} />
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
