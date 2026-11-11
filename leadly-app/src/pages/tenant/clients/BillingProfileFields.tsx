import type { ClientBillingAddress, ClientBillingProfile } from '../../../types/domain'
import { GeoSelect } from '@/components/molecules'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useLanguage } from '../../../contexts/LanguageContext'
import type { TranslationKey } from '../../../i18n/translations'

const emptyAddress: ClientBillingAddress = {
  line1: null, country: null, city: null, state_province: null, city_code: null, state_code: null,
}

const responsibilities = ['O-13', 'O-15', 'O-23', 'O-47'] as const

export function BillingProfileFields({ profile, onChange }: {
  profile: ClientBillingProfile
  onChange: (profile: ClientBillingProfile) => void
}) {
  const { t } = useLanguage()
  const address = profile.address ?? emptyAddress
  const selected = profile.tax_level_code?.split(';') ?? []
  const update = (patch: Partial<ClientBillingProfile>) => onChange({ ...profile, ...patch })
  const updateAddress = (patch: Partial<ClientBillingAddress>) => {
    const next = { ...address, ...patch }
    update({ address: Object.values(next).some(Boolean) ? next : null })
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">{t('contacts.billing.hint')}</p>
      <div>
        <Label htmlFor="billing-legal-name">{t('contacts.billing.legalName')}</Label>
        <Input id="billing-legal-name" value={profile.legal_name ?? ''} onChange={(e) => update({ legal_name: e.target.value })} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="billing-person">{t('contacts.billing.person')}</Label>
          <Select value={profile.organization_type ?? ''} onValueChange={(value) => update({ organization_type: value === '1' ? '1' : '2' })}>
            <SelectTrigger id="billing-person" className="w-full"><SelectValue placeholder={t('common.form.selectPlaceholder')} /></SelectTrigger>
            <SelectContent>
              <SelectItem value="2">{t('contacts.billing.natural')}</SelectItem>
              <SelectItem value="1">{t('contacts.billing.legal')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label htmlFor="billing-tax">{t('contacts.billing.tax')}</Label>
          <Select value={profile.tax_scheme_code ?? ''} onValueChange={(value) => update({ tax_scheme_code: value as ClientBillingProfile['tax_scheme_code'] })}>
            <SelectTrigger id="billing-tax" className="w-full"><SelectValue placeholder={t('common.form.selectPlaceholder')} /></SelectTrigger>
            <SelectContent>
              <SelectItem value="01">IVA</SelectItem>
              <SelectItem value="04">INC</SelectItem>
              <SelectItem value="ZA">IVA e INC</SelectItem>
              <SelectItem value="ZZ">{t('contacts.billing.notApplicable')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <fieldset className="space-y-1">
        <legend className="mb-1 text-sm font-medium">{t('contacts.billing.responsibilities')}</legend>
        {responsibilities.map((code) => (
          <label key={code} className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={selected.includes(code)} onChange={(event) => {
              const codes = responsibilities.filter((item) => item === code ? event.target.checked : selected.includes(item))
              update({ tax_level_code: codes.length ? codes.join(';') : 'R-99-PN' })
            }} />
            {t(`contacts.billing.${code}` as TranslationKey)}
          </label>
        ))}
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={selected.includes('R-99-PN')} onChange={(e) => update({ tax_level_code: e.target.checked ? 'R-99-PN' : null })} />
          {t('contacts.billing.notApplicable')}
        </label>
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="billing-delivery">{t('contacts.billing.delivery')}</Label>
          <Select value={profile.delivery_method ?? 'default'} onValueChange={(value) => update({ delivery_method: value === 'default' ? null : value === 'email' ? 'email' : 'print' })}>
            <SelectTrigger id="billing-delivery" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="default">{t('contacts.billing.defaultDelivery')}</SelectItem>
              <SelectItem value="email">{t('contacts.billing.email')}</SelectItem>
              <SelectItem value="print">{t('contacts.billing.print')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label htmlFor="billing-email">{t('contacts.billing.email')}</Label>
          <Input id="billing-email" type="email" value={profile.email ?? ''} onChange={(e) => update({ email: e.target.value })} />
        </div>
      </div>
      <div>
        <Label htmlFor="billing-line1">{t('contacts.billing.address')}</Label>
        <Input id="billing-line1" value={address.line1 ?? ''} onChange={(e) => updateAddress({ line1: e.target.value })} />
      </div>
      <div>
        <Label htmlFor="billing-country">{t('contacts.billing.country')}</Label>
        <Input id="billing-country" placeholder="CO" maxLength={2} value={address.country ?? ''} onChange={(e) => updateAddress({
          country: e.target.value.toUpperCase(), city: null, state_province: null, city_code: null, state_code: null,
        })} />
      </div>
      {address.country === 'CO' ? (
        <GeoSelect idPrefix="billing-address" stateCode={address.state_code} cityCode={address.city_code}
          stateLabel={t('contacts.billing.state')} cityLabel={t('contacts.billing.city')}
          onChange={(geo) => updateAddress({
            state_code: geo.stateCode, city_code: geo.cityCode, state_province: geo.stateName, city: geo.cityName,
          })} />
      ) : address.country && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="billing-state">{t('contacts.billing.state')}</Label>
            <Input id="billing-state" value={address.state_province ?? ''} onChange={(e) => updateAddress({ state_province: e.target.value })} />
          </div>
          <div>
            <Label htmlFor="billing-city">{t('contacts.billing.city')}</Label>
            <Input id="billing-city" value={address.city ?? ''} onChange={(e) => updateAddress({ city: e.target.value })} />
          </div>
        </div>
      )}
    </div>
  )
}
