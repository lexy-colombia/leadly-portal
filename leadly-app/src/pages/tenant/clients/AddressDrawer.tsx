import { useEffect, useState, type FormEvent } from 'react'
import { createAddress, updateAddress } from '../../../lib/api/addresses'
import type { ContactAddress } from '../../../types/domain'
import { FieldError } from '@/components/atoms'
import { Drawer } from '@/components/organisms'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { GeoSelect } from '@/components/molecules'
import { isNotBlank } from '../../../lib/validation'
import { useLanguage } from '../../../contexts/LanguageContext'

const FIELD_CLASS = '!h-7 !rounded-lg !text-xs'
const TEXTAREA_CLASS = '!rounded-lg !py-1.5 !text-xs'

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
  address?: ContactAddress | null
  onSaved: (address: ContactAddress) => void
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
  const [cityCode, setCityCode] = useState<string | null>(null)
  const [stateCode, setStateCode] = useState<string | null>(null)
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
    setCityCode(address?.city_code ?? null)
    setStateCode(address?.state_code ?? null)
    setPostalCode(address?.postal_code ?? '')
    setCountry(address?.country ?? 'Colombia')
    setNotes(address?.notes ?? '')
    setIsDefault(address?.is_default ?? false)
    setTouched(false)
    setFormError(null)
  }, [open, address])

  const line1Error = touched && !isNotBlank(line1) ? t('contacts.addressDrawer.errors.line1Required') : undefined
  // El picker de departamento/ciudad (con código DANE real) solo tiene
  // sentido para Colombia -- la DIAN solo valida esos códigos cuando
  // Country/IdentificationCode="CO" (ver buildInvoiceXml.ts). Para
  // cualquier otro país, ciudad/departamento se siguen escribiendo libres,
  // como antes.
  const isColombia = country.trim().toLowerCase() === 'colombia'

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
        city_code: isColombia ? cityCode : null,
        state_code: isColombia ? stateCode : null,
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
          <Input id="address-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t('contacts.addressDrawer.fields.labelPlaceholder')} className={`mt-1 ${FIELD_CLASS}`} />
        </div>

        <div className="divide-y divide-brand-100 rounded-lg border border-brand-100">
          <div className="flex items-center justify-between px-3 py-2.5">
            <Label htmlFor="address-shipping" className="font-normal text-brand-700">
              {t('contacts.addressDrawer.fields.isShipping')}
            </Label>
            <Switch id="address-shipping" checked={isShipping} onCheckedChange={setIsShipping} />
          </div>
          <div className="flex items-center justify-between px-3 py-2.5">
            <Label htmlFor="address-billing" className="font-normal text-brand-700">
              {t('contacts.addressDrawer.fields.isBilling')}
            </Label>
            <Switch id="address-billing" checked={isBilling} onCheckedChange={setIsBilling} />
          </div>
          <div className="flex items-center justify-between px-3 py-2.5">
            <Label htmlFor="address-default" className="font-normal text-brand-700">
              {t('contacts.addressDrawer.fields.isDefault')}
            </Label>
            <Switch id="address-default" checked={isDefault} onCheckedChange={setIsDefault} />
          </div>
        </div>

        <div>
          <Label htmlFor="address-line1">{t('contacts.addressDrawer.fields.line1')}</Label>
          <Input
            id="address-line1"
            value={line1}
            aria-invalid={!!line1Error}
            onChange={(e) => setLine1(e.target.value)}
            placeholder={t('contacts.addressDrawer.fields.line1Placeholder')}
            className={`mt-1 ${FIELD_CLASS}`}
          />
          <FieldError message={line1Error} />
        </div>

        <div>
          <Label htmlFor="address-line2">{t('contacts.addressDrawer.fields.line2')}</Label>
          <Input id="address-line2" value={line2} onChange={(e) => setLine2(e.target.value)} placeholder={t('contacts.addressDrawer.fields.line2Placeholder')} className={`mt-1 ${FIELD_CLASS}`} />
        </div>

        {isColombia ? (
          // Elegidos de la lista real de la DIAN (DIVIPOLA) -- ya trae el
          // código DANE que la factura electrónica necesita para esta
          // dirección cuando es de facturación (reglas FAK09/FAK29/FAK32,
          // ver buildInvoiceXml.ts), sin que nadie tenga que escribirlo a
          // mano. `city`/`state_province` (el nombre legible que ya usaba
          // el resto de la app) se completan solos desde la elección.
          <GeoSelect
            stateCode={stateCode}
            cityCode={cityCode}
            onChange={({ stateCode: nextState, cityCode: nextCity, stateName, cityName }) => {
              setStateCode(nextState)
              setCityCode(nextCity)
              setStateProvince(stateName ?? '')
              setCity(cityName ?? '')
            }}
            stateLabel={t('contacts.addressDrawer.fields.state')}
            cityLabel={t('contacts.addressDrawer.fields.city')}
            idPrefix="address-geo"
          />
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="address-city">{t('contacts.addressDrawer.fields.city')}</Label>
              <Input id="address-city" value={city} onChange={(e) => setCity(e.target.value)} className={`mt-1 ${FIELD_CLASS}`} />
            </div>
            <div>
              <Label htmlFor="address-state">{t('contacts.addressDrawer.fields.state')}</Label>
              <Input id="address-state" value={stateProvince} onChange={(e) => setStateProvince(e.target.value)} className={`mt-1 ${FIELD_CLASS}`} />
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="address-postal">{t('contacts.addressDrawer.fields.postalCode')}</Label>
            <Input id="address-postal" value={postalCode} onChange={(e) => setPostalCode(e.target.value)} className={`mt-1 ${FIELD_CLASS}`} />
          </div>
          <div>
            <Label htmlFor="address-country">{t('contacts.addressDrawer.fields.country')}</Label>
            <Input id="address-country" value={country} onChange={(e) => setCountry(e.target.value)} className={`mt-1 ${FIELD_CLASS}`} />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="address-recipient">{t('contacts.addressDrawer.fields.recipientName')}</Label>
            <Input id="address-recipient" value={recipientName} onChange={(e) => setRecipientName(e.target.value)} className={`mt-1 ${FIELD_CLASS}`} />
          </div>
          <div>
            <Label htmlFor="address-phone">{t('contacts.addressDrawer.fields.phone')}</Label>
            <Input id="address-phone" value={phone} onChange={(e) => setPhone(e.target.value)} className={`mt-1 ${FIELD_CLASS}`} />
          </div>
        </div>

        <div>
          <Label htmlFor="address-tax-id">{t('contacts.addressDrawer.fields.taxId')}</Label>
          <Input id="address-tax-id" value={taxId} onChange={(e) => setTaxId(e.target.value)} className={`mt-1 ${FIELD_CLASS}`} />
        </div>

        <div>
          <Label htmlFor="address-notes">{t('contacts.addressDrawer.fields.notes')}</Label>
          <Textarea id="address-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={`mt-1 ${TEXTAREA_CLASS}`} />
        </div>

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
