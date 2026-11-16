import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { createBillingProfile, updateBillingProfile, type BillingProfileInput } from '../../../lib/api/billingProfiles'
import { billingProfileMissingKeys, isUniqueViolation, organizationTypeForDocument } from '../../../lib/billingProfile'
import { listDianDocumentTypes } from '../../../lib/api/tenantDianProfile'
import type { ClientBillingProfile, DianDocumentType } from '../../../types/domain'
import { Drawer } from '@/components/organisms'
import { CountrySelect, GeoSelect } from '@/components/molecules'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { normalizeCountryValue } from '../../../lib/countryValue'
import { useLanguage } from '../../../contexts/LanguageContext'
import type { TranslationKey } from '../../../i18n/translations'
import { BillingMissingList } from './BillingMissingList'

const FIELD_CLASS = '!h-7 !rounded-lg !text-xs'
const RESPONSIBILITIES = ['O-13', 'O-15', 'O-23', 'O-47'] as const

/** Dirección con la que se puede precargar el domicilio fiscal de un perfil
 * NUEVO (solo como valor inicial editable, p. ej. la dirección de entrega en
 * la tienda). Nunca vincula los dos: es una copia de partida. */
export interface BillingProfileSeed {
  legal_name?: string | null
  email?: string | null
  address_line1?: string | null
  address_line2?: string | null
  country?: string | null
  state_code?: string | null
  city_code?: string | null
  state_province?: string | null
  city?: string | null
}

/** Alta/edición de un perfil de facturación del cliente. Compartido por la
 * ficha del cliente, Órdenes y POS. No valida reglas de negocio: guarda lo
 * escrito y MUESTRA qué falta para emitir (lista informativa; el servidor es
 * la autoridad al emitir). */
export function BillingProfileDrawer({
  open,
  onClose,
  tenantId,
  clientId,
  profile,
  seed,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  tenantId: string
  clientId: string
  profile?: ClientBillingProfile | null
  seed?: BillingProfileSeed | null
  onSaved: (profile: ClientBillingProfile) => void
}) {
  const { t } = useLanguage()
  const [documentTypes, setDocumentTypes] = useState<DianDocumentType[]>([])
  const [label, setLabel] = useState('')
  const [documentTypeCode, setDocumentTypeCode] = useState('')
  const [documentNumber, setDocumentNumber] = useState('')
  const [legalName, setLegalName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [taxScheme, setTaxScheme] = useState<ClientBillingProfile['tax_scheme_code']>(null)
  const [taxLevel, setTaxLevel] = useState('R-99-PN')
  const [appliesWithholding, setAppliesWithholding] = useState(false)
  const [line1, setLine1] = useState('')
  const [line2, setLine2] = useState('')
  const [country, setCountry] = useState('')
  const [stateCode, setStateCode] = useState<string | null>(null)
  const [cityCode, setCityCode] = useState<string | null>(null)
  const [stateName, setStateName] = useState('')
  const [cityName, setCityName] = useState('')
  // Tipo de persona: null = deducido del documento (editable).
  const [organizationType, setOrganizationType] = useState<'1' | '2' | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    listDianDocumentTypes().then(setDocumentTypes).catch(() => {})
  }, [open])

  useEffect(() => {
    if (!open) return
    const src = profile ?? null
    setLabel(src?.label ?? '')
    setDocumentTypeCode(src?.document_type_code ?? '')
    setDocumentNumber(src?.document_number ?? '')
    setLegalName(src?.legal_name ?? seed?.legal_name ?? '')
    setEmail(src?.email ?? seed?.email ?? '')
    setPhone(src?.phone ?? '')
    setTaxScheme(src?.tax_scheme_code ?? null)
    setTaxLevel(src?.tax_level_code ?? 'R-99-PN')
    setAppliesWithholding(src?.applies_withholding ?? false)
    const addr = src ?? seed ?? null
    setLine1(addr?.address_line1 ?? '')
    setLine2(addr?.address_line2 ?? '')
    // Perfil nuevo sin domicilio: país vacío (persona natural sin domicilio fiscal).
    setCountry(normalizeCountryValue(addr?.country))
    setStateCode(addr?.state_code ?? null)
    setCityCode(addr?.city_code ?? null)
    setStateName(addr?.state_province ?? '')
    setCityName(addr?.city ?? '')
    // Al editar se respeta lo guardado; en uno nuevo se deduce del documento.
    setOrganizationType(src ? src.organization_type : null)
    setFormError(null)
  }, [open, profile, seed])

  const selectedType = documentTypes.find((d) => d.code === documentTypeCode)
  const selectedLevels = taxLevel.split(';')
  const draftMissing = useMemo(
    () =>
      billingProfileMissingKeys({
        legal_name: legalName,
        document_type_code: documentTypeCode || null,
        document_number: documentNumber,
        email,
        tax_level_code: taxLevel,
        address_line1: line1,
        country: country || null,
        city: cityName,
        state_code: stateCode,
        city_code: cityCode,
      }),
    [legalName, documentTypeCode, documentNumber, email, taxLevel, line1, country, cityName, stateCode, cityCode],
  )

  function toggleLevel(code: (typeof RESPONSIBILITIES)[number], checked: boolean) {
    const codes = RESPONSIBILITIES.filter((c) => (c === code ? checked : selectedLevels.includes(c)))
    setTaxLevel(codes.length ? codes.join(';') : 'R-99-PN')
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setFormError(null)
    setSubmitting(true)
    try {
      const hasAddress = !!(line1.trim() || country || cityName.trim())
      const input: BillingProfileInput = {
        label: label.trim() || undefined,
        document_type_code: documentTypeCode || null,
        document_number: documentNumber.trim() || null,
        legal_name: legalName.trim() || null,
        email: email.trim() || null,
        phone: phone.trim() || null,
        organization_type: organizationType ?? organizationTypeForDocument(documentTypeCode || null),
        tax_level_code: taxLevel,
        tax_scheme_code: taxScheme,
        applies_withholding: appliesWithholding,
        address_line1: hasAddress ? line1.trim() || null : null,
        address_line2: hasAddress ? line2.trim() || null : null,
        country: hasAddress ? country || null : null,
        state_code: country === 'CO' ? stateCode : null,
        city_code: country === 'CO' ? cityCode : null,
        state_province: hasAddress ? stateName.trim() || null : null,
        city: hasAddress ? cityName.trim() || null : null,
      }
      const saved = profile ? await updateBillingProfile(profile.id, input) : await createBillingProfile(tenantId, clientId, input)
      onSaved(saved)
      onClose()
    } catch (err) {
      setFormError(isUniqueViolation(err) ? t('contacts.billingProfiles.errors.duplicateDocument') : err instanceof Error ? err.message : t('contacts.billingProfiles.errors.saveFailed'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={profile ? t('contacts.billingProfiles.editTitle') : t('contacts.billingProfiles.newTitle')}
      description={t('contacts.billingProfiles.description')}
      size="lg"
    >
      <form onSubmit={handleSubmit} noValidate className="space-y-3">
        <div>
          <Label htmlFor="bp-label">{t('contacts.billingProfiles.fields.label')}</Label>
          <Input id="bp-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t('contacts.billingProfiles.fields.labelPlaceholder')} className={`mt-1 ${FIELD_CLASS}`} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="bp-doc-type">{t('contacts.drawer.fields.dianDocumentType')}</Label>
            <Select value={documentTypeCode} onValueChange={setDocumentTypeCode}>
              <SelectTrigger id="bp-doc-type" className={`mt-1 w-full ${FIELD_CLASS}`}>
                <SelectValue placeholder={t('common.form.selectPlaceholder')}>{selectedType?.name}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {documentTypes.map((d) => (
                  <SelectItem key={d.code} value={d.code}>{d.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="bp-doc-number">{t('contacts.drawer.fields.documentNumber')}</Label>
            <Input id="bp-doc-number" value={documentNumber} onChange={(e) => setDocumentNumber(e.target.value)} className={`mt-1 ${FIELD_CLASS}`} />
          </div>
        </div>
        <div>
          <Label htmlFor="bp-org-type">{t('contacts.billingProfiles.fields.organizationType')}</Label>
          <Select value={organizationType ?? organizationTypeForDocument(documentTypeCode || null)} onValueChange={(v) => setOrganizationType(v as '1' | '2')}>
            <SelectTrigger id="bp-org-type" className={`mt-1 w-full ${FIELD_CLASS}`}><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="1">{t('contacts.billingProfiles.fields.orgLegal')}</SelectItem>
              <SelectItem value="2">{t('contacts.billingProfiles.fields.orgNatural')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label htmlFor="bp-legal-name">{t('contacts.billing.legalName')}</Label>
          <Input id="bp-legal-name" value={legalName} onChange={(e) => setLegalName(e.target.value)} className={`mt-1 ${FIELD_CLASS}`} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="bp-email">{t('contacts.billing.email')}</Label>
            <Input id="bp-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={`mt-1 ${FIELD_CLASS}`} />
          </div>
          <div>
            <Label htmlFor="bp-phone">{t('contacts.billingProfiles.fields.phone')}</Label>
            <Input id="bp-phone" value={phone} onChange={(e) => setPhone(e.target.value)} className={`mt-1 ${FIELD_CLASS}`} />
          </div>
        </div>
        <p className="text-[11px] text-brand-400">{t('contacts.billingProfiles.emailHint')}</p>

        <div>
          <Label htmlFor="bp-tax">{t('contacts.billing.tax')}</Label>
          <Select value={taxScheme ?? 'none'} onValueChange={(v) => setTaxScheme(v === 'none' ? null : (v as ClientBillingProfile['tax_scheme_code']))}>
            <SelectTrigger id="bp-tax" className={`mt-1 w-full ${FIELD_CLASS}`}><SelectValue placeholder={t('common.form.selectPlaceholder')} /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">{t('contacts.billingProfiles.fields.taxNone')}</SelectItem>
              <SelectItem value="01">IVA</SelectItem>
              <SelectItem value="04">INC</SelectItem>
              <SelectItem value="ZA">IVA e INC</SelectItem>
              <SelectItem value="ZZ">{t('contacts.billing.notApplicable')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <fieldset className="space-y-1">
          <legend className="mb-1 text-sm font-medium">{t('contacts.billing.responsibilities')}</legend>
          {RESPONSIBILITIES.map((code) => (
            <label key={code} className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={selectedLevels.includes(code)} onChange={(e) => toggleLevel(code, e.target.checked)} />
              {t(`contacts.billing.${code}` as TranslationKey)}
            </label>
          ))}
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={selectedLevels.includes('R-99-PN')} onChange={(e) => setTaxLevel(e.target.checked ? 'R-99-PN' : selectedLevels.filter((c) => c !== 'R-99-PN').join(';') || 'R-99-PN')} />
            {t('contacts.billing.notApplicable')}
          </label>
        </fieldset>
        <div className="flex items-center justify-between rounded-lg border border-brand-100 px-3 py-2.5">
          <div>
            <Label htmlFor="bp-withholding" className="font-normal text-brand-700">{t('contacts.drawer.fields.appliesWithholding')}</Label>
            <p className="mt-0.5 text-[11px] text-brand-400">{t('contacts.drawer.fields.appliesWithholdingHint')}</p>
          </div>
          <Switch id="bp-withholding" checked={appliesWithholding} onCheckedChange={setAppliesWithholding} />
        </div>

        <p className="pt-1 text-[11px] font-semibold tracking-wide text-brand-400 uppercase">{t('contacts.billingProfiles.fiscalAddress')}</p>
        <CountrySelect
          idPrefix="bp"
          label={t('contacts.billing.country')}
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
        {country === 'CO' ? (
          <GeoSelect
            idPrefix="bp-geo"
            stateCode={stateCode}
            cityCode={cityCode}
            stateLabel={t('contacts.billing.state')}
            cityLabel={t('contacts.billing.city')}
            onChange={(geo) => {
              setStateCode(geo.stateCode)
              setCityCode(geo.cityCode)
              setStateName(geo.stateName ?? '')
              setCityName(geo.cityName ?? '')
            }}
          />
        ) : (
          country && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="bp-state">{t('contacts.billing.state')}</Label>
                <Input id="bp-state" value={stateName} onChange={(e) => setStateName(e.target.value)} className={`mt-1 ${FIELD_CLASS}`} />
              </div>
              <div>
                <Label htmlFor="bp-city">{t('contacts.billing.city')}</Label>
                <Input id="bp-city" value={cityName} onChange={(e) => setCityName(e.target.value)} className={`mt-1 ${FIELD_CLASS}`} />
              </div>
            </div>
          )
        )}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="bp-line1">{t('contacts.billing.address')}</Label>
            <Input id="bp-line1" value={line1} onChange={(e) => { setLine1(e.target.value); if (!country && e.target.value.trim()) setCountry('CO') }} className={`mt-1 ${FIELD_CLASS}`} />
          </div>
          <div>
            <Label htmlFor="bp-line2">{t('contacts.addressDrawer.fields.line2')}</Label>
            <Input id="bp-line2" value={line2} onChange={(e) => setLine2(e.target.value)} className={`mt-1 ${FIELD_CLASS}`} />
          </div>
        </div>

        <BillingMissingList keys={draftMissing} />
        {formError && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{formError}</p>}

        <div className="flex gap-2 border-t border-brand-100 pt-4">
          <Button type="submit" disabled={submitting}>{submitting ? t('common.actions.saving') : t('common.actions.save')}</Button>
          <Button type="button" variant="ghost" onClick={onClose}>{t('common.actions.cancel')}</Button>
        </div>
      </form>
    </Drawer>
  )
}
