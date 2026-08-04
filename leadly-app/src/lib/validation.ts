const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
// E.164: optional leading +, 8-15 digits total, first digit 1-9.
const E164_PHONE_PATTERN = /^\+?[1-9]\d{7,14}$/
// Meta phone_number_id / business_account_id are numeric-only identifiers.
const META_NUMERIC_ID_PATTERN = /^\d{5,30}$/

export const PASSWORD_MIN_LENGTH = 8

export function isValidEmail(value: string) {
  return EMAIL_PATTERN.test(value.trim().toLowerCase())
}

/** Supabase Auth itself lowercases/trims email on signup/signin, so the value
 * sent from the client should match to avoid confusing "wrong password"
 * errors caused only by casing differences the user typed. */
export function normalizeEmail(value: string) {
  return value.trim().toLowerCase()
}

export function isValidE164Phone(value: string) {
  return E164_PHONE_PATTERN.test(value.trim())
}

export function isValidMetaNumericId(value: string) {
  return META_NUMERIC_ID_PATTERN.test(value.trim())
}

export function isNotBlank(value: string) {
  return value.trim().length > 0
}

export function isValidPassword(value: string) {
  return value.length >= PASSWORD_MIN_LENGTH
}

export function isValidTemperature(value: number) {
  return Number.isFinite(value) && value >= 0 && value <= 2
}

export function isValidMaxTokens(value: number) {
  return Number.isInteger(value) && value > 0 && value <= 8192
}
