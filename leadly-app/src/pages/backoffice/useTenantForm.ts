import { useState } from 'react'
import type { TenantInput } from '../../lib/api/tenants'
import type { TenantDocumentType, TenantEntityType, TenantLanguage } from '../../types/domain'
import { isNotBlank, isValidE164Phone, isValidEmail } from '../../lib/validation'
import { useLanguage } from '../../contexts/LanguageContext'

/** Shared form state + validation for both "Nuevo cliente" and the edit form
 * on the client detail page -- one place to change validation rules instead
 * of two forms drifting apart.
 *
 * Required-ness reflects real use cases, not "everything optional":
 * - name, entity_type, document_type/number, contact email/phone, country,
 *   state and language are always required -- a client Leadly actually bills
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
  const [country, setCountry] = useState(initial?.country ?? '')
  const [stateProvince, setStateProvince] = useState(initial?.state_province ?? '')
  const [billingAddress, setBillingAddress] = useState(initial?.billing_address ?? '')
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
  const stateProvinceError = touched && !isNotBlank(stateProvince) ? t('backoffice.tenantForm.errors.stateProvince') : undefined

  function isValid() {
    return (
      isNotBlank(name) &&
      (entityType !== 'empresa' || isNotBlank(legalName)) &&
      !!documentType &&
      isNotBlank(documentNumber) &&
      isValidEmail(contactEmail) &&
      isValidE164Phone(contactPhone) &&
      !!country &&
      isNotBlank(stateProvince)
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
      state_province: stateProvince.trim() || null,
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
    setStateProvince,
    billingAddress,
    setBillingAddress,
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
    isValid,
    toInput,
  }
}

export type TenantFormState = ReturnType<typeof useTenantForm>
