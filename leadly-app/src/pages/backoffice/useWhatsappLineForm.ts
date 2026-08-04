import { useState } from 'react'
import type { WhatsappLineInput } from '../../lib/api/whatsappLines'
import { isNotBlank, isValidMetaNumericId } from '../../lib/validation'

export function useWhatsappLineForm(initial?: Partial<WhatsappLineInput>) {
  const [tenantId, setTenantId] = useState(initial?.tenant_id ?? '')
  const [displayName, setDisplayName] = useState(initial?.display_name ?? '')
  const [phoneNumberId, setPhoneNumberId] = useState(initial?.phone_number_id ?? '')
  const [businessAccountId, setBusinessAccountId] = useState(initial?.business_account_id ?? '')
  const [touched, setTouched] = useState(false)

  const tenantIdError = touched && !isNotBlank(tenantId) ? 'Selecciona un cliente.' : undefined
  const displayNameError = touched && !isNotBlank(displayName) ? 'El nombre es obligatorio.' : undefined
  const phoneNumberIdError =
    touched && !isValidMetaNumericId(phoneNumberId) ? 'Debe ser el phone_number_id numérico que da Meta.' : undefined
  const businessAccountIdError =
    touched && !isValidMetaNumericId(businessAccountId) ? 'Debe ser el business_account_id numérico que da Meta.' : undefined

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
