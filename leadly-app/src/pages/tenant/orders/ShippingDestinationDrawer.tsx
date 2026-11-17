import { useEffect, useState, type FormEvent } from 'react'
import { createAddress } from '../../../lib/api/addresses'
import { normalizeCountryValue } from '../../../lib/countryValue'
import type { ShippingDestination } from '../../../lib/shippingDestination'
import type { ClientDeliveryAddress } from '../../../types/domain'
import { FieldError } from '@/components/atoms'
import { Drawer } from '@/components/organisms'
import { CountrySelect, GeoSelect } from '@/components/molecules'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { isNotBlank } from '../../../lib/validation'
import { useLanguage } from '../../../contexts/LanguageContext'

const FIELD_CLASS = '!h-7 !rounded-lg !text-xs'

/** Destino de entrega para UN pedido. Dos salidas: «Usar en este pedido» (no
 * entra a la libreta del cliente) o «Guardar también en el cliente» (crea la
 * dirección en la libreta y se usa por su id). Captura país y, para Colombia,
 * departamento/municipio con sus códigos DANE. */
export function ShippingDestinationDrawer({
  open,
  onClose,
  tenantId,
  contactId,
  initial,
  onUseOnce,
  onSavedToClient,
}: {
  open: boolean
  onClose: () => void
  tenantId: string
  contactId: string
  initial?: ShippingDestination | null
  onUseOnce: (destination: ShippingDestination) => void
  onSavedToClient: (address: ClientDeliveryAddress) => void
}) {
  const { t } = useLanguage()
  const [recipient, setRecipient] = useState('')
  const [phone, setPhone] = useState('')
  const [country, setCountry] = useState('CO')
  const [stateCode, setStateCode] = useState<string | null>(null)
  const [cityCode, setCityCode] = useState<string | null>(null)
  const [stateName, setStateName] = useState('')
  const [cityName, setCityName] = useState('')
  const [line1, setLine1] = useState('')
  const [line2, setLine2] = useState('')
  const [postal, setPostal] = useState('')
  const [notes, setNotes] = useState('')
  const [touched, setTouched] = useState(false)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setRecipient(initial?.recipient_name ?? '')
    setPhone(initial?.phone ?? '')
    setCountry(initial ? normalizeCountryValue(initial.country) : 'CO')
    setStateCode(initial?.state_code ?? null)
    setCityCode(initial?.city_code ?? null)
    setStateName(initial?.state_province ?? '')
    setCityName(initial?.city ?? '')
    setLine1(initial?.line1 ?? '')
    setLine2(initial?.line2 ?? '')
    setPostal(initial?.postal_code ?? '')
    setNotes(initial?.notes ?? '')
    setTouched(false)
    setFormError(null)
  }, [open, initial])

  const isColombia = country === 'CO'
  const line1Error = touched && !isNotBlank(line1) ? t('contacts.addressDrawer.errors.line1Required') : undefined

  function build(): ShippingDestination {
    return {
      recipient_name: recipient.trim() || null,
      phone: phone.trim() || null,
      line1: line1.trim(),
      line2: line2.trim() || null,
      city: cityName.trim() || null,
      state_province: stateName.trim() || null,
      state_code: isColombia ? stateCode : null,
      city_code: isColombia ? cityCode : null,
      postal_code: postal.trim() || null,
      notes: notes.trim() || null,
      country: country || null,
    }
  }

  function handleUseOnce(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    if (!isNotBlank(line1)) return
    onUseOnce(build())
    onClose()
  }

  async function handleSaveToClient() {
    setTouched(true)
    setFormError(null)
    if (!isNotBlank(line1)) return
    setSaving(true)
    try {
      const d = build()
      const saved = await createAddress({
        tenant_id: tenantId,
        contact_id: contactId,
        recipient_name: d.recipient_name,
        phone: d.phone,
        line1: d.line1,
        line2: d.line2,
        city: d.city,
        state_province: d.state_province,
        city_code: d.city_code,
        state_code: d.state_code,
        postal_code: d.postal_code,
        country: d.country,
        notes: d.notes,
      })
      onSavedToClient(saved)
      onClose()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('contacts.addressDrawer.errors.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Drawer open={open} onClose={onClose} title={t('orders.destination.title')} description={t('orders.destination.description')}>
      <form onSubmit={handleUseOnce} noValidate className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="dest-recipient">{t('contacts.addressDrawer.fields.recipientName')}</Label>
            <Input id="dest-recipient" value={recipient} onChange={(e) => setRecipient(e.target.value)} className={`mt-1 ${FIELD_CLASS}`} />
          </div>
          <div>
            <Label htmlFor="dest-phone">{t('contacts.addressDrawer.fields.phone')}</Label>
            <Input id="dest-phone" value={phone} onChange={(e) => setPhone(e.target.value)} className={`mt-1 ${FIELD_CLASS}`} />
          </div>
        </div>
        <CountrySelect
          idPrefix="dest"
          label={t('contacts.addressDrawer.fields.country')}
          noneLabel={t('contacts.billing.noCountry')}
          value={country}
          onChange={(code) => {
            setCountry(code)
            setStateCode(null)
            setCityCode(null)
            setStateName('')
            setCityName('')
          }}
        />
        {isColombia ? (
          <GeoSelect
            idPrefix="dest-geo"
            stateCode={stateCode}
            cityCode={cityCode}
            stateLabel={t('contacts.addressDrawer.fields.state')}
            cityLabel={t('contacts.addressDrawer.fields.city')}
            onChange={(geo) => {
              setStateCode(geo.stateCode)
              setCityCode(geo.cityCode)
              setStateName(geo.stateName ?? '')
              setCityName(geo.cityName ?? '')
            }}
          />
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="dest-city">{t('contacts.addressDrawer.fields.city')}</Label>
              <Input id="dest-city" value={cityName} onChange={(e) => setCityName(e.target.value)} className={`mt-1 ${FIELD_CLASS}`} />
            </div>
            <div>
              <Label htmlFor="dest-state">{t('contacts.addressDrawer.fields.state')}</Label>
              <Input id="dest-state" value={stateName} onChange={(e) => setStateName(e.target.value)} className={`mt-1 ${FIELD_CLASS}`} />
            </div>
          </div>
        )}
        <div>
          <Label htmlFor="dest-line1">{t('contacts.addressDrawer.fields.line1')}</Label>
          <Input id="dest-line1" value={line1} aria-invalid={!!line1Error} onChange={(e) => setLine1(e.target.value)} placeholder={t('contacts.addressDrawer.fields.line1Placeholder')} className={`mt-1 ${FIELD_CLASS}`} />
          <FieldError message={line1Error} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="dest-line2">{t('contacts.addressDrawer.fields.line2')}</Label>
            <Input id="dest-line2" value={line2} onChange={(e) => setLine2(e.target.value)} className={`mt-1 ${FIELD_CLASS}`} />
          </div>
          <div>
            <Label htmlFor="dest-postal">{t('contacts.addressDrawer.fields.postalCode')}</Label>
            <Input id="dest-postal" value={postal} onChange={(e) => setPostal(e.target.value)} className={`mt-1 ${FIELD_CLASS}`} />
          </div>
        </div>
        <div>
          <Label htmlFor="dest-notes">{t('contacts.addressDrawer.fields.notes')}</Label>
          <Textarea id="dest-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className="mt-1 !rounded-lg !py-1.5 !text-xs" />
        </div>
        {formError && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{formError}</p>}
        <div className="flex flex-wrap gap-2 border-t border-brand-100 pt-4">
          <Button type="submit" disabled={saving}>{t('orders.destination.useOnce')}</Button>
          <Button type="button" variant="secondary" disabled={saving} onClick={handleSaveToClient}>
            {saving ? t('common.actions.saving') : t('orders.destination.saveToClient')}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>{t('common.actions.cancel')}</Button>
        </div>
        <p className="text-[11px] text-brand-400">{t('orders.destination.hint')}</p>
      </form>
    </Drawer>
  )
}
