import { useEffect, useState, type FormEvent } from 'react'
import { createPqr } from '../../../lib/api/pqrs'
import { uploadPqrAttachment } from '../../../lib/api/attachments'
import type { CrmPqr, PqrType } from '../../../types/domain'
import { Button, Drawer, FieldError, Input, Label, Select, Textarea } from '../../../components/ui'
import { ImageAttachmentPicker } from '../../../components/ImageAttachmentPicker'
import { isNotBlank } from '../../../lib/validation'

export const PQR_TYPE_LABEL: Record<PqrType, string> = {
  peticion: 'Petición',
  queja: 'Queja',
  reclamo: 'Reclamo',
}

export function PqrDrawer({
  open,
  onClose,
  tenantId,
  contactId,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  tenantId: string
  contactId: string
  onCreated: (pqr: CrmPqr) => void
}) {
  const [type, setType] = useState<PqrType>('peticion')
  const [subject, setSubject] = useState('')
  const [description, setDescription] = useState('')
  const [attachment, setAttachment] = useState<File | null>(null)
  const [touched, setTouched] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setType('peticion')
    setSubject('')
    setDescription('')
    setAttachment(null)
    setTouched(false)
    setFormError(null)
  }, [open])

  const subjectError = touched && !isNotBlank(subject) ? 'El asunto es obligatorio.' : undefined

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    setFormError(null)
    if (!isNotBlank(subject)) return

    setSubmitting(true)
    try {
      const pqr = await createPqr(tenantId, contactId, { type, subject: subject.trim(), description: description.trim() })
      if (attachment) {
        // Best-effort: the PQR itself is already saved at this point, so an
        // attachment upload failure shouldn't block the whole action -- the
        // agent can still see/retry it from the case detail afterwards.
        try {
          await uploadPqrAttachment(tenantId, attachment, { pqrId: pqr.id })
        } catch (attachmentErr) {
          console.error('No se pudo subir la imagen del PQR', attachmentErr)
        }
      }
      onCreated(pqr)
      onClose()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'No se pudo crear el PQR.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Drawer open={open} onClose={onClose} title="Nuevo PQR" description="Petición, queja o reclamo del cliente.">
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        <div>
          <Label htmlFor="pqr-type">Tipo</Label>
          <Select id="pqr-type" value={type} onChange={(e) => setType(e.target.value as PqrType)}>
            {(Object.keys(PQR_TYPE_LABEL) as PqrType[]).map((t) => (
              <option key={t} value={t}>
                {PQR_TYPE_LABEL[t]}
              </option>
            ))}
          </Select>
        </div>

        <div>
          <Label htmlFor="pqr-subject">Asunto</Label>
          <Input id="pqr-subject" value={subject} invalid={!!subjectError} onChange={(e) => setSubject(e.target.value)} placeholder="Resumen breve del caso" />
          <FieldError message={subjectError} />
        </div>

        <div>
          <Label htmlFor="pqr-description">Descripción (opcional)</Label>
          <Textarea id="pqr-description" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Detalle de la petición, queja o reclamo..." rows={4} />
        </div>

        <ImageAttachmentPicker file={attachment} onChange={setAttachment} />

        {formError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</p>}

        <div className="flex gap-2 border-t border-brand-100 pt-5">
          <Button type="submit" variant="secondary" disabled={submitting}>
            {submitting ? 'Guardando…' : 'Crear PQR'}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
        </div>
      </form>
    </Drawer>
  )
}
