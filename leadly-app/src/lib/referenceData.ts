import type { TenantDocumentType, TenantLanguage } from '../types/domain'

/** Curated, not exhaustive -- covers Lexy Colombia's expected markets. "OT" for
 * anything else keeps the field from blocking a real signup while we don't
 * have a full ISO country list wired up. */
export const COUNTRIES: { code: string; label: string }[] = [
  { code: 'CO', label: 'Colombia' },
  { code: 'MX', label: 'México' },
  { code: 'AR', label: 'Argentina' },
  { code: 'CL', label: 'Chile' },
  { code: 'PE', label: 'Perú' },
  { code: 'EC', label: 'Ecuador' },
  { code: 'VE', label: 'Venezuela' },
  { code: 'PA', label: 'Panamá' },
  { code: 'CR', label: 'Costa Rica' },
  { code: 'US', label: 'Estados Unidos' },
  { code: 'ES', label: 'España' },
  { code: 'OT', label: 'Otro' },
]

export const DOCUMENT_TYPES: { value: TenantDocumentType; label: string }[] = [
  { value: 'NIT', label: 'NIT' },
  { value: 'CC', label: 'Cédula de ciudadanía' },
  { value: 'CE', label: 'Cédula de extranjería' },
  { value: 'RUC', label: 'RUC' },
  { value: 'RFC', label: 'RFC' },
  { value: 'PASAPORTE', label: 'Pasaporte' },
  { value: 'OTRO', label: 'Otro' },
]

export const LANGUAGES: { value: TenantLanguage; label: string }[] = [
  { value: 'es', label: 'Español' },
  { value: 'en', label: 'English' },
]

export const TENANT_LOGO_MAX_BYTES = 5 * 1024 * 1024
export const TENANT_LOGO_ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']
