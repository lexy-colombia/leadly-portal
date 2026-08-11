import { useEffect, useState, type FormEvent } from 'react'
import { createPqr } from '../../../lib/api/pqrs'
import { uploadPqrAttachment } from '../../../lib/api/attachments'
import type { CrmPqr, PqrType } from '../../../types/domain'
import { Button, Drawer, FieldError, Input, Label, Select, Textarea } from '../../../components/ui'
import { ImageAttachmentPicker } from '../../../components/ImageAttachmentPicker'
import { isNotBlank } from '../../../lib/validation'
import { useLanguage } from '../../../contexts/LanguageContext'
import type { TranslationKey } from '../../../i18n/translations'

export const PQR_TYPE_LABEL: Record<PqrType, TranslationKey> = {
  peticion: 'contacts.pqr.type.peticion',
  queja: 'contacts.pqr.type.queja',
  reclamo: 'contacts.pqr.type.reclamo',
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
  const { t } = useLanguage()
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

  const subjectError = touched && !isNotBlank(subject) ? t('contacts.pqrDrawer.errors.subjectRequired') : undefined

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
      setFormError(err instanceof Error ? err.message : t('contacts.pqrDrawer.errors.createFailed'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Drawer open={open} onClose={onClose} title={t('contacts.pqrDrawer.title')} description={t('contacts.pqrDrawer.description')}>
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        <div>
          <Label htmlFor="pqr-type">{t('contacts.pqrDrawer.fields.type')}</Label>
          <Select id="pqr-type" value={type} onChange={(e) => setType(e.target.value as PqrType)}>
            {(Object.keys(PQR_TYPE_LABEL) as PqrType[]).map((pt) => (
              <option key={pt} value={pt}>
                {t(PQR_TYPE_LABEL[pt])}
              </option>
            ))}
          </Select>
        </div>

        <div>
          <Label htmlFor="pqr-subject">{t('contacts.pqrDrawer.fields.subject')}</Label>
          <Input
            id="pqr-subject"
            value={subject}
            invalid={!!subjectError}
            onChange={(e) => setSubject(e.target.value)}
            placeholder={t('contacts.pqrDrawer.fields.subjectPlaceholder')}
          />
          <FieldError message={subjectError} />
        </div>

        <div>
          <Label htmlFor="pqr-description">{t('contacts.pqrDrawer.fields.description')}</Label>
          <Textarea
            id="pqr-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t('contacts.pqrDrawer.fields.descriptionPlaceholder')}
            rows={4}
          />
        </div>

        <ImageAttachmentPicker file={attachment} onChange={setAttachment} />

        {formError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</p>}

        <div className="flex gap-2 border-t border-brand-100 pt-5">
          <Button type="submit" variant="secondary" disabled={submitting}>
            {submitting ? t('common.actions.saving') : t('contacts.pqrDrawer.submit')}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('common.actions.cancel')}
          </Button>
        </div>
      </form>
    </Drawer>
  )
}
