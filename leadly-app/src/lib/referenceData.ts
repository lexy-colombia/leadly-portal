import type { TenantDocumentType, TenantLanguage } from '../types/domain'
import type { TranslationKey } from '../i18n/translations'

/** Curated, not exhaustive -- covers Lexy Colombia's expected markets. "OT" for
 * anything else keeps the field from blocking a real signup while we don't
 * have a full ISO country list wired up. `labelKey` instead of a literal
 * label since this is plain data (no access to the language context) --
 * callers resolve it with `t()`. */
export const COUNTRIES: { code: string; labelKey: TranslationKey }[] = [
  { code: 'CO', labelKey: 'backoffice.countries.CO' },
  { code: 'MX', labelKey: 'backoffice.countries.MX' },
  { code: 'AR', labelKey: 'backoffice.countries.AR' },
  { code: 'CL', labelKey: 'backoffice.countries.CL' },
  { code: 'PE', labelKey: 'backoffice.countries.PE' },
  { code: 'EC', labelKey: 'backoffice.countries.EC' },
  { code: 'VE', labelKey: 'backoffice.countries.VE' },
  { code: 'PA', labelKey: 'backoffice.countries.PA' },
  { code: 'CR', labelKey: 'backoffice.countries.CR' },
  { code: 'US', labelKey: 'backoffice.countries.US' },
  { code: 'ES', labelKey: 'backoffice.countries.ES' },
  { code: 'OT', labelKey: 'backoffice.countries.OT' },
]

export const DOCUMENT_TYPES: { value: TenantDocumentType; labelKey: TranslationKey }[] = [
  { value: 'NIT', labelKey: 'backoffice.documentTypes.NIT' },
  { value: 'CC', labelKey: 'backoffice.documentTypes.CC' },
  { value: 'CE', labelKey: 'backoffice.documentTypes.CE' },
  { value: 'RUC', labelKey: 'backoffice.documentTypes.RUC' },
  { value: 'RFC', labelKey: 'backoffice.documentTypes.RFC' },
  { value: 'PASAPORTE', labelKey: 'backoffice.documentTypes.PASAPORTE' },
  { value: 'OTRO', labelKey: 'backoffice.documentTypes.OTRO' },
]

export const LANGUAGES: { value: TenantLanguage; labelKey: TranslationKey }[] = [
  { value: 'es', labelKey: 'backoffice.languages.es' },
  { value: 'en', labelKey: 'backoffice.languages.en' },
]

export const TENANT_LOGO_MAX_BYTES = 5 * 1024 * 1024
export const TENANT_LOGO_ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']

export const PQR_ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024
export const PQR_ATTACHMENT_ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp']

// Task attachments allow PDF too (a task attachment is very likely a
// proposal/quote sent to a client), unlike PQR evidence photos.
export const TASK_ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024
export const TASK_ATTACHMENT_ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf']
