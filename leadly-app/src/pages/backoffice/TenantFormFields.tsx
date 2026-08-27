import { FieldError } from '@/components/atoms'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { COUNTRIES, DOCUMENT_TYPES, LANGUAGES } from '../../lib/referenceData'
import type { TenantFormState } from './useTenantForm'
import { useLanguage } from '../../contexts/LanguageContext'

/** `compact` tightens spacing/sizing for narrow contexts (a Drawer, ~448px)
 * -- the default spacing was tuned for the backoffice's full-width page and
 * reads as too tall/loose inside a side panel. Same fields either way,
 * just less breathing room and one fewer grid column per row so nothing
 * gets cramped at drawer width. */
export function TenantFormFields({ form, hideNotes = false, compact = false }: { form: TenantFormState; hideNotes?: boolean; compact?: boolean }) {
  const { t } = useLanguage()
  const sectionGap = compact ? 'space-y-3.5' : 'space-y-6'
  const rowGap = compact ? 'gap-3' : 'gap-4'
  const rowCols2 = 'grid sm:grid-cols-2'
  const rowCols3 = compact ? 'grid sm:grid-cols-2' : 'grid sm:grid-cols-3'

  return (
    <div className={sectionGap}>
      <div>
        <Label>{t('backoffice.tenantForm.type')}</Label>
        <div className={`grid grid-cols-2 ${compact ? 'gap-1.5' : 'gap-2'}`}>
          {(['empresa', 'persona'] as const).map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => form.setEntityType(type)}
              className={`rounded-xl border font-medium transition-colors ${compact ? 'px-2.5 py-1.5 text-xs' : 'px-3 py-2.5 text-sm'} ${
                form.entityType === type
                  ? 'border-accent-400 bg-accent-50 text-accent-700'
                  : 'border-brand-200 text-brand-500 hover:bg-brand-50'
              }`}
            >
              {type === 'empresa' ? t('backoffice.tenantForm.type.empresa') : t('backoffice.tenantForm.type.persona')}
            </button>
          ))}
        </div>
      </div>

      <div className={`${rowCols2} ${rowGap}`}>
        <div>
          <Label htmlFor="tenant-name">{t('backoffice.tenantForm.name')}</Label>
          <Input
            id="tenant-name"
            value={form.name}
            aria-invalid={!!form.nameError}
            onChange={(e) => form.setName(e.target.value)}
            placeholder={t('backoffice.tenantForm.name.placeholder')}
            className="mt-1"
          />
          <FieldError message={form.nameError} />
        </div>

        <div>
          <Label htmlFor="tenant-legal-name">
            {form.entityType === 'empresa' ? t('backoffice.tenantForm.legalName.empresa') : t('backoffice.tenantForm.legalName.persona')}
          </Label>
          <Input
            id="tenant-legal-name"
            value={form.legalName}
            aria-invalid={!!form.legalNameError}
            onChange={(e) => form.setLegalName(e.target.value)}
            placeholder={form.entityType === 'empresa' ? t('backoffice.tenantForm.legalName.placeholder.empresa') : t('backoffice.tenantForm.legalName.placeholder.persona')}
            className="mt-1"
          />
          <FieldError message={form.legalNameError} />
        </div>
      </div>

      <div className={`${rowCols2} ${rowGap}`}>
        <div>
          <Label htmlFor="tenant-document-type">{t('backoffice.tenantForm.documentType')}</Label>
          <Select value={form.documentType} onValueChange={(v) => form.setDocumentType(v as typeof form.documentType)}>
            <SelectTrigger id="tenant-document-type" aria-invalid={!!form.documentTypeError} className="mt-1 w-full">
              <SelectValue placeholder={t('common.form.selectPlaceholder')} />
            </SelectTrigger>
            <SelectContent>
              {DOCUMENT_TYPES.map((d) => (
                <SelectItem key={d.value} value={d.value}>
                  {t(d.labelKey)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldError message={form.documentTypeError} />
        </div>

        <div>
          <Label htmlFor="tenant-document-number">{t('backoffice.tenantForm.documentNumber')}</Label>
          <Input
            id="tenant-document-number"
            value={form.documentNumber}
            aria-invalid={!!form.documentNumberError}
            onChange={(e) => form.setDocumentNumber(e.target.value)}
            placeholder={t('backoffice.tenantForm.documentNumber.placeholder')}
            className="mt-1"
          />
          <FieldError message={form.documentNumberError} />
        </div>
      </div>

      <div className={`${rowCols2} ${rowGap}`}>
        <div>
          <Label htmlFor="tenant-email">{t('backoffice.tenantForm.contactEmail')}</Label>
          <Input
            id="tenant-email"
            type="email"
            value={form.contactEmail}
            aria-invalid={!!form.emailError}
            onChange={(e) => form.setContactEmail(e.target.value)}
            placeholder="contacto@empresa.com"
            className="mt-1"
          />
          <FieldError message={form.emailError} />
        </div>

        <div>
          <Label htmlFor="tenant-phone">{t('backoffice.tenantForm.contactPhone')}</Label>
          <Input
            id="tenant-phone"
            value={form.contactPhone}
            aria-invalid={!!form.phoneError}
            onChange={(e) => form.setContactPhone(e.target.value)}
            placeholder="+573001234567"
            className="mt-1"
          />
          <FieldError message={form.phoneError} />
        </div>
      </div>

      <div className={`${rowCols3} ${rowGap}`}>
        <div>
          <Label htmlFor="tenant-country">{t('backoffice.tenantForm.country')}</Label>
          <Select value={form.country} onValueChange={(v) => form.setCountry(v)}>
            <SelectTrigger id="tenant-country" aria-invalid={!!form.countryError} className="mt-1 w-full">
              <SelectValue placeholder={t('common.form.selectPlaceholder')} />
            </SelectTrigger>
            <SelectContent>
              {COUNTRIES.map((c) => (
                <SelectItem key={c.code} value={c.code}>
                  {t(c.labelKey)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldError message={form.countryError} />
        </div>

        <div>
          <Label htmlFor="tenant-state">{t('backoffice.tenantForm.stateProvince')}</Label>
          <Input
            id="tenant-state"
            value={form.stateProvince}
            aria-invalid={!!form.stateProvinceError}
            onChange={(e) => form.setStateProvince(e.target.value)}
            placeholder={t('backoffice.tenantForm.stateProvince.placeholder')}
            className="mt-1"
          />
          <FieldError message={form.stateProvinceError} />
        </div>

        <div>
          <Label htmlFor="tenant-language">{t('backoffice.tenantForm.preferredLanguage')}</Label>
          <Select value={form.preferredLanguage} onValueChange={(v) => form.setPreferredLanguage(v as typeof form.preferredLanguage)}>
            <SelectTrigger id="tenant-language" className="mt-1 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LANGUAGES.map((l) => (
                <SelectItem key={l.value} value={l.value}>
                  {t(l.labelKey)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div>
        <Label htmlFor="tenant-billing-address">{t('backoffice.tenantForm.billingAddress')}</Label>
        <Input
          id="tenant-billing-address"
          value={form.billingAddress}
          onChange={(e) => form.setBillingAddress(e.target.value)}
          placeholder={t('backoffice.tenantForm.billingAddress.placeholder')}
          className="mt-1"
        />
      </div>

      {!hideNotes && (
        <div>
          <Label htmlFor="tenant-notes">{t('backoffice.tenantForm.notes')}</Label>
          <Textarea id="tenant-notes" rows={3} value={form.notes} onChange={(e) => form.setNotes(e.target.value)} className="mt-1" />
        </div>
      )}
    </div>
  )
}
