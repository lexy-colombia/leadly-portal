import type { ClientBillingProfile } from '../types/domain'

/** Espejo de PRESENTACIÓN de `billingProfileMissing` (servidor:
 * leadly-db/supabase/functions/_shared/invoicing/clientBillingProfile.ts).
 *
 * Solo sirve para MOSTRAR "qué falta para emitir" en la ficha y en los
 * selectores de «Facturar a». NUNCA bloquea un guardado ni un cobro: el
 * servidor es la autoridad (devuelve su propia lista en `billing_missing` y
 * bloquea la factura). Si el servidor cambia una regla, hay que cambiar acá
 * y en tests/billing-profile.test.mjs. Las claves son estables para i18n. */

export type BillingMissingKey =
  | 'legalName'
  | 'documentType'
  | 'documentNumber'
  | 'validNit'
  | 'validCheckDigit'
  | 'taxLevel'
  | 'addressLine'
  | 'country'
  | 'geo'

type FiscalFields = Pick<
  ClientBillingProfile,
  | 'legal_name' | 'document_type_code' | 'document_number' | 'email' | 'tax_level_code'
  | 'address_line1' | 'country' | 'city' | 'state_code' | 'city_code'
>

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Dígito de verificación del NIT (módulo 11, DIAN). */
export function nitCheckDigit(nit: string): number {
  const weights = [3, 7, 13, 17, 19, 23, 29, 37, 41, 43, 47, 53, 59, 67, 71]
  const digits = nit.replace(/\D/g, '').split('').reverse().map(Number)
  const total = digits.reduce((sum, d, i) => sum + d * (weights[i] ?? 0), 0)
  const remainder = total % 11
  return remainder <= 1 ? remainder : 11 - remainder
}

/** Formato de correo del formulario de perfiles (única regla de campo que el
 * frontend aplica a propósito, por decisión del usuario: el servidor ya no
 * exige correo a compradores con nombre). */
export function isValidProfileEmail(email: string | null | undefined): boolean {
  return EMAIL_RE.test((email ?? '').trim())
}

/** Perfil guardado sin correo (p. ej. uno antiguo): solo informativo en los
 * selectores, no impide elegirlo ni emitir. */
export function profileHasNoEmail(p: { email: string | null }): boolean {
  return !(p.email ?? '').trim()
}

export function billingProfileMissingKeys(p: FiscalFields): BillingMissingKey[] {
  const missing: BillingMissingKey[] = []
  const documentNumber = p.document_number?.trim() || null
  if (!p.legal_name?.trim()) missing.push('legalName')
  if (!p.document_type_code) missing.push('documentType')
  if (!documentNumber) missing.push('documentNumber')
  if (p.document_type_code === '31' && documentNumber) {
    const nit = /^([0-9]{1,15})(?:-([0-9]))?$/.exec(documentNumber.replace(/[.\s]/g, ''))
    if (!nit) missing.push('validNit')
    else if (nit[2] && Number(nit[2]) !== nitCheckDigit(nit[1])) missing.push('validCheckDigit')
  }
  if (!p.tax_level_code) missing.push('taxLevel')
  const hasAddress = !!(p.address_line1?.trim() || p.country || p.city?.trim())
  if (hasAddress) {
    if (!p.address_line1?.trim()) missing.push('addressLine')
    if (!p.country || !/^[A-Z]{2}$/.test(p.country) || p.country === 'OT') missing.push('country')
    if (p.country === 'CO' && (!p.city_code || !p.state_code)) missing.push('geo')
  }
  return missing
}

/** Persona jurídica (NIT / NIT de otro país) = '1'; el resto '2' -- misma
 * regla que ya usaba el formulario de clientes. */
export function organizationTypeForDocument(documentTypeCode: string | null): '1' | '2' {
  return documentTypeCode === '31' || documentTypeCode === '50' ? '1' : '2'
}

/** Normaliza un error de PostgREST de unicidad (23505) del perfil a un código
 * que la UI traduce; otro error se devuelve tal cual. */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505'
}
