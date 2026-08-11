import { useState } from 'react'
import type { WhatsappLineInput } from '../../lib/api/whatsappLines'
import { isNotBlank, isValidMetaNumericId } from '../../lib/validation'
import { useLanguage } from '../../contexts/LanguageContext'

export function useWhatsappLineForm(initial?: Partial<WhatsappLineInput>) {
  const { t } = useLanguage()
  const [tenantId, setTenantId] = useState(initial?.tenant_id ?? '')
  const [displayName, setDisplayName] = useState(initial?.display_name ?? '')
  const [phoneNumberId, setPhoneNumberId] = useState(initial?.phone_number_id ?? '')
  const [businessAccountId, setBusinessAccountId] = useState(initial?.business_account_id ?? '')
  const [touched, setTouched] = useState(false)

  const tenantIdError = touched && !isNotBlank(tenantId) ? t('backoffice.whatsappLineForm.errors.tenant') : undefined
  const displayNameError = touched && !isNotBlank(displayName) ? t('backoffice.whatsappLineForm.errors.name') : undefined
  const phoneNumberIdError =
    touched && !isValidMetaNumericId(phoneNumberId) ? t('backoffice.whatsappLineForm.errors.phoneNumberId') : undefined
  const businessAccountIdError =
    touched && !isValidMetaNumericId(businessAccountId) ? t('backoffice.whatsappLineForm.errors.businessAccountId') : undefined

  function isValid() {
    return (
      isNotBlank(tenantId) &&
      isNotBlank(displayName) &&
      isValidMetaNumericId(phoneNumberId) &&
      isValidMetaNumericId(businessAccountId)
    )
  }

  function toInput(): WhatsappLineInput {
    return {
      tenant_id: tenantId,
      display_name: displayName.trim(),
      phone_number_id: phoneNumberId.trim(),
      business_account_id: businessAccountId.trim(),
    }
  }

  return {
    tenantId,
    setTenantId,
    displayName,
    setDisplayName,
    phoneNumberId,
    setPhoneNumberId,
    businessAccountId,
    setBusinessAccountId,
    touched,
    setTouched,
    tenantIdError,
    displayNameError,
    phoneNumberIdError,
    businessAccountIdError,
    isValid,
    toInput,
  }
}

export type WhatsappLineFormState = ReturnType<typeof useWhatsappLineForm>
