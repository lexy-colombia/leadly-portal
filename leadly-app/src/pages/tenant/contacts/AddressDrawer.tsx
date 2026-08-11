import { useEffect, useState, type FormEvent } from 'react'
import { createAddress, updateAddress } from '../../../lib/api/addresses'
import type { CrmContactAddress } from '../../../types/domain'
import { Button, Drawer, FieldError, Input, Label, Switch, Textarea } from '../../../components/ui'
import { isNotBlank } from '../../../lib/validation'
import { useLanguage } from '../../../contexts/LanguageContext'

export function AddressDrawer({
  open,
  onClose,
  tenantId,
  contactId,
  address,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  tenantId: string
  contactId: string
  /** Present when editing an existing address; omitted when creating a new one. */
  address?: CrmContactAddress | null
  onSaved: (address: CrmContactAddress) => void
}) {
  const { t } = useLanguage()
  const [label, setLabel] = useState('')
  const [isShipping, setIsShipping] = useState(true)
  const [isBilling, setIsBilling] = useState(false)
  const [recipientName, setRecipientName] = useState('')
  const [phone, setPhone] = useState('')
  const [taxId, setTaxId] = useState('')
  const [line1, setLine1] = useState('')
  const [line2, setLine2] = useState('')
  const [city, setCity] = useState('')
  const [stateProvince, setStateProvince] = useState('')
  const [postalCode, setPostalCode] = useState('')
  const [country, setCountry] = useState('Colombia')
  const [notes, setNotes] = useState('')
  const [isDefault, setIsDefault] = useState(false)
  const [touched, setTouched] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setLabel(address?.label ?? '')
    setIsShipping(address?.is_shipping ?? true)
    setIsBilling(address?.is_billing ?? false)
    setRecipientName(address?.recipient_name ?? '')
    setPhone(address?.phone ?? '')
    setTaxId(address?.tax_id ?? '')
    setLine1(address?.line1 ?? '')
    setLine2(address?.line2 ?? '')
    setCity(address?.city ?? '')
    setStateProvince(address?.state_province ?? '')
    setPostalCode(address?.postal_code ?? '')
    setCountry(address?.country ?? 'Colombia')
    setNotes(address?.notes ?? '')
    setIsDefault(address?.is_default ?? false)
    setTouched(false)
    setFormError(null)
  }, [open, address])

  const line1Error = touched && !isNotBlank(line1) ? t('contacts.addressDrawer.errors.line1Required') : undefined

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    setFormError(null)
    if (!isNotBlank(line1)) return

    setSubmitting(true)
    try {
      const input = {
        tenant_id: tenantId,
        contact_id: contactId,
        label: label.trim() || null,
        is_shipping: isShipping,
        is_billing: isBilling,
        recipient_name: recipientName.trim() || null,
        phone: phone.trim() || null,
        tax_id: taxId.trim() || null,
        line1: line1.trim(),
        line2: line2.trim() || null,
        city: city.trim() || null,
        state_province: stateProvince.trim() || null,
        postal_code: postalCode.trim() || null,
        country: country.trim() || null,
        notes: notes.trim() || null,
        is_default: isDefault,
      }
      const saved = address ? await updateAddress(address.id, contactId, input) : await createAddress(input)
      onSaved(saved)
      onClose()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('contacts.addressDrawer.errors.saveFailed'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={address ? t('contacts.addressDrawer.editTitle') : t('contacts.addressDrawer.newTitle')}
      description={t('contacts.addressDrawer.description')}
    >
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        <div>
          <Label htmlFor="address-label">{t('contacts.addressDrawer.fields.label')}</Label>
          <Input id="address-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t('contacts.addressDrawer.fields.labelPlaceholder')} />
        </div>

        <div className="flex gap-4">
          <label className="flex items-center gap-2 text-sm text-brand-700">
            <input type="checkbox" checked={isShipping} onChange={(e) => setIsShipping(e.target.checked)} className="h-4 w-4 rounded border-brand-300 text-accent-600" />
            {t('contacts.addressDrawer.fields.isShipping')}
          </label>
          <label className="flex items-center gap-2 text-sm text-brand-700">
            <input type="checkbox" checked={isBilling} onChange={(e) => setIsBilling(e.target.checked)} className="h-4 w-4 rounded border-brand-300 text-accent-600" />
            {t('contacts.addressDrawer.fields.isBilling')}
          </label>
        </div>

        <div>
          <Label htmlFor="address-line1">{t('contacts.addressDrawer.fields.line1')}</Label>
          <Input
            id="address-line1"
            value={line1}
            invalid={!!line1Error}
            onChange={(e) => setLine1(e.target.value)}
            placeholder={t('contacts.addressDrawer.fields.line1Placeholder')}
          />
          <FieldError message={line1Error} />
        </div>

        <div>
          <Label htmlFor="address-line2">{t('contacts.addressDrawer.fields.line2')}</Label>
          <Input id="address-line2" value={line2} onChange={(e) => setLine2(e.target.value)} placeholder={t('contacts.addressDrawer.fields.line2Placeholder')} />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="address-city">{t('contacts.addressDrawer.fields.city')}</Label>
            <Input id="address-city" value={city} onChange={(e) => setCity(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="address-state">{t('contacts.addressDrawer.fields.state')}</Label>
            <Input id="address-state" value={stateProvince} onChange={(e) => setStateProvince(e.target.value)} />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="address-postal">{t('contacts.addressDrawer.fields.postalCode')}</Label>
            <Input id="address-postal" value={postalCode} onChange={(e) => setPostalCode(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="address-country">{t('contacts.addressDrawer.fields.country')}</Label>
            <Input id="address-country" value={country} onChange={(e) => setCountry(e.target.value)} />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="address-recipient">{t('contacts.addressDrawer.fields.recipientName')}</Label>
            <Input id="address-recipient" value={recipientName} onChange={(e) => setRecipientName(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="address-phone">{t('contacts.addressDrawer.fields.phone')}</Label>
            <Input id="address-phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </div>
        </div>

        <div>
          <Label htmlFor="address-tax-id">{t('contacts.addressDrawer.fields.taxId')}</Label>
          <Input id="address-tax-id" value={taxId} onChange={(e) => setTaxId(e.target.value)} />
        </div>

        <div>
          <Label htmlFor="address-notes">{t('contacts.addressDrawer.fields.notes')}</Label>
          <Textarea id="address-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
        </div>

        <div className="flex items-center justify-between rounded-lg border border-brand-100 px-3 py-2.5">
          <span className="text-sm text-brand-700">{t('contacts.addressDrawer.fields.isDefault')}</span>
          <Switch checked={isDefault} onChange={setIsDefault} />
        </div>

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
