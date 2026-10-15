import { useState } from 'react'
import type { TenantInput } from '../../lib/api/tenants'
import type { TenantDocumentType, TenantEntityType, TenantFiscalRegime, TenantLanguage } from '../../types/domain'
import { isNotBlank, isValidE164Phone, isValidEmail } from '../../lib/validation'
import { useLanguage } from '../../contexts/LanguageContext'
import { GEO_COUNTRY_CODE } from '../../lib/api/geo'

/** Shared form state + validation for both "Nuevo cliente" and the edit form
 * on the client detail page -- one place to change validation rules instead
 * of two forms drifting apart.
 *
 * Required-ness reflects real use cases, not "everything optional":
 * - name, entity_type, document_type/number, contact email/phone, country
 *   and language are always required; departamento y ciudad (DIVIPOLA)
 *   solo se piden -- y solo se guardan -- cuando el país es Colombia -- a client Leadly actually bills
 *   and messages needs all of this.
 * - legal_name is required only for `empresa` (a `persona natural` doesn't
 *   have a separate razón social from their own name).
 * - notes and the logo stay optional.
 */
export function useTenantForm(initial?: Partial<TenantInput>) {
  const { t } = useLanguage()
  const [name, setName] = useState(initial?.name ?? '')
  const [entityType, setEntityType] = useState<TenantEntityType>(initial?.entity_type ?? 'empresa')
  const [legalName, setLegalName] = useState(initial?.legal_name ?? '')
  const [documentType, setDocumentType] = useState<TenantDocumentType | ''>(initial?.document_type ?? '')
  const [documentNumber, setDocumentNumber] = useState(initial?.document_number ?? '')
  const [contactEmail, setContactEmail] = useState(initial?.contact_email ?? '')
  const [contactPhone, setContactPhone] = useState(initial?.contact_phone ?? '')
  const [country, setCountryRaw] = useState(initial?.country ?? '')
  const [stateProvince, setStateProvince] = useState(initial?.state_province ?? '')
  const [stateCode, setStateCode] = useState(initial?.state_code ?? '')
  const [cityCode, setCityCode] = useState(initial?.city_code ?? '')
  const isColombia = country === GEO_COUNTRY_CODE

  // Cambiar a un país que no es Colombia limpia departamento y ciudad: la
  // base rechaza (CHECK) guardarlos con otro país.
  function setCountry(next: string) {
    setCountryRaw(next)
    if (next !== GEO_COUNTRY_CODE) {
      setStateCode('')
      setCityCode('')
      setStateProvince('')
    }
  }

  function setGeo(next: { stateCode: string | null; stateName: string | null; cityCode: string | null }) {
    setStateCode(next.stateCode ?? '')
    setStateProvince(next.stateName ?? '')
    setCityCode(next.cityCode ?? '')
  }
  const [billingAddress, setBillingAddress] = useState(initial?.billing_address ?? '')
  const [fiscalRegime, setFiscalRegime] = useState<TenantFiscalRegime | ''>(initial?.fiscal_regime ?? '')
  const [isSelfWithholdingAgent, setIsSelfWithholdingAgent] = useState(initial?.is_self_withholding_agent ?? false)
  const [taxEnabled, setTaxEnabled] = useState(initial?.tax_enabled ?? false)
  const [preferredLanguage, setPreferredLanguage] = useState<TenantLanguage>(initial?.preferred_language ?? 'es')
  const [notes, setNotes] = useState(initial?.notes ?? '')
  const [touched, setTouched] = useState(false)

  const nameError = touched && !isNotBlank(name) ? t('backoffice.tenantForm.errors.name') : undefined
  const legalNameError =
    touched && entityType === 'empresa' && !isNotBlank(legalName) ? t('backoffice.tenantForm.errors.legalName') : undefined
  const documentTypeError = touched && !documentType ? t('backoffice.tenantForm.errors.documentType') : undefined
  const documentNumberError = touched && !isNotBlank(documentNumber) ? t('backoffice.tenantForm.errors.documentNumber') : undefined
  const emailError = touched && !isValidEmail(contactEmail) ? t('auth.errors.invalidEmail') : undefined
  const phoneError = touched && !isValidE164Phone(contactPhone) ? t('backoffice.tenantForm.errors.phone') : undefined
  const countryError = touched && !country ? t('backoffice.tenantForm.errors.country') : undefined
  const stateProvinceError = touched && isColombia && !stateCode ? t('backoffice.tenantForm.errors.stateProvince') : undefined
  const cityError = touched && isColombia && !cityCode ? t('backoffice.tenantForm.errors.city') : undefined

  function isValid() {
    return (
      isNotBlank(name) &&
      (entityType !== 'empresa' || isNotBlank(legalName)) &&
      !!documentType &&
      isNotBlank(documentNumber) &&
      isValidEmail(contactEmail) &&
      isValidE164Phone(contactPhone) &&
      !!country &&
      (!isColombia || (!!stateCode && !!cityCode))
    )
  }

  function toInput(): TenantInput {
    return {
      name: name.trim(),
      entity_type: entityType,
      legal_name: entityType === 'empresa' ? legalName.trim() : legalName.trim() || null,
      document_type: documentType || null,
      document_number: documentNumber.trim() || null,
      contact_email: contactEmail.trim() || null,
      contact_phone: contactPhone.trim() || null,
      country: country || null,
      state_province: isColombia ? stateProvince.trim() || null : null,
      state_code: isColombia ? stateCode || null : null,
      city_code: isColombia ? cityCode || null : null,
      fiscal_regime: fiscalRegime || null,
      is_self_withholding_agent: isSelfWithholdingAgent,
      tax_enabled: taxEnabled,
      billing_address: billingAddress.trim() || null,
      preferred_language: preferredLanguage,
      notes: notes.trim() || null,
    }
  }

  return {
    name,
    setName,
    entityType,
    setEntityType,
    legalName,
    setLegalName,
    documentType,
    setDocumentType,
    documentNumber,
    setDocumentNumber,
    contactEmail,
    setContactEmail,
    contactPhone,
    setContactPhone,
    country,
    setCountry,
    stateProvince,
    stateCode,
    cityCode,
    isColombia,
    setGeo,
    billingAddress,
    setBillingAddress,
    fiscalRegime,
    setFiscalRegime,
    isSelfWithholdingAgent,
    setIsSelfWithholdingAgent,
    taxEnabled,
    setTaxEnabled,
    preferredLanguage,
    setPreferredLanguage,
    notes,
    setNotes,
    touched,
    setTouched,
    nameError,
    legalNameError,
    documentTypeError,
    documentNumberError,
    emailError,
    phoneError,
    countryError,
    stateProvinceError,
    cityError,
    isValid,
    toInput,
  }
}

export type TenantFormState = ReturnType<typeof useTenantForm>
