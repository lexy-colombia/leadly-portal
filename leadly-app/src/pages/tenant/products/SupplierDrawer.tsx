import { useEffect, useState, type FormEvent } from 'react'
import { createSupplier, updateSupplier } from '../../../lib/api/suppliers'
import type { Supplier } from '../../../types/domain'
import { useLanguage } from '../../../contexts/LanguageContext'
import { FieldError } from '@/components/atoms'
import { Drawer } from '@/components/organisms'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { isNotBlank } from '../../../lib/validation'

const FIELD_CLASS = '!h-7 !rounded-lg !text-xs'
const TEXTAREA_CLASS = '!rounded-lg !py-1.5 !text-xs'

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
  supplier?: Supplier | null
  onSaved: () => void
}) {
  const { t } = useLanguage()
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

  const nameError = touched && !isNotBlank(name) ? t('products.suppliers.errors.nameRequired') : undefined

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
      setFormError(err instanceof Error ? err.message : t('products.suppliers.errors.save'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={supplier ? t('products.suppliers.drawer.editTitle') : t('products.suppliers.drawer.newTitle')}
      description={t('products.suppliers.drawer.description')}
    >
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        <div>
          <Label htmlFor="supplier-name">{t('products.suppliers.fields.name')}</Label>
          <Input
            id="supplier-name"
            value={name}
            aria-invalid={!!nameError}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('products.suppliers.fields.namePlaceholder')}
            className={`mt-1 ${FIELD_CLASS}`}
          />
          <FieldError message={nameError} />
        </div>

        <div>
          <Label htmlFor="supplier-contact">{t('products.suppliers.fields.contactPerson')}</Label>
          <Input id="supplier-contact" value={contactName} onChange={(e) => setContactName(e.target.value)} className={`mt-1 ${FIELD_CLASS}`} />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="supplier-phone">{t('products.suppliers.fields.phone')}</Label>
            <Input id="supplier-phone" value={phone} onChange={(e) => setPhone(e.target.value)} className={`mt-1 ${FIELD_CLASS}`} />
          </div>
          <div>
            <Label htmlFor="supplier-email">{t('products.suppliers.fields.email')}</Label>
            <Input id="supplier-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={`mt-1 ${FIELD_CLASS}`} />
          </div>
        </div>

        <div>
          <Label htmlFor="supplier-notes">{t('products.suppliers.fields.notes')}</Label>
          <Textarea id="supplier-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} className={`mt-1 ${TEXTAREA_CLASS}`} />
        </div>

        <div className="flex items-center justify-between rounded-lg border border-brand-100 px-3 py-2.5">
          <Label htmlFor="supplier-active" className="font-normal text-brand-700">
            {t('products.suppliers.fields.active')}
          </Label>
          <Switch id="supplier-active" checked={isActive} onCheckedChange={setIsActive} />
        </div>

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
