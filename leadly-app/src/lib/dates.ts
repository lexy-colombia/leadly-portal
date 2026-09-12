import type { Language } from '../i18n/translations'

/** Standard date format across the whole app: DD-MM-YYYY, always numeric,
 * always dash-separated -- explicit product decision (no more mixing
 * "short month"/"long month"/slash formats across screens). Deliberately
 * NOT locale-dependent (unlike the rest of the app's number/currency
 * formatting, which does follow es-CO/en-US) -- the day-month-year order is
 * fixed regardless of language. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  // Una columna `date` de Postgres llega como "YYYY-MM-DD", sin hora. Pasarla
  // por `new Date` la interpreta como medianoche UTC, que en Colombia (UTC-5)
  // son las 7 p. m. del día anterior -- la fecha se mostraba un día antes.
  // Es un día de calendario, no un instante: se arma tal cual llega.
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (dateOnly) return `${dateOnly[3]}-${dateOnly[2]}-${dateOnly[1]}`
  const d = new Date(iso)
  const day = String(d.getDate()).padStart(2, '0')
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const year = d.getFullYear()
  return `${day}-${month}-${year}`
}

/** formatDate's date part plus a localized time (still respects `language`
 * for am/pm formatting, e.g. "a. m." in es-CO vs "AM" in en-US) -- for
 * wherever the exact moment, not just the day, matters. */
export function formatDateTime(iso: string | null | undefined, language: Language): string {
  if (!iso) return '—'
  const locale = language === 'en' ? 'en-US' : 'es-CO'
  const time = new Date(iso).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
  return `${formatDate(iso)}, ${time}`
}

/** formatDateTime's time part alone -- for table cells that already show
 * the date on its own line and just need the time as a secondary line. */
export function formatTime(iso: string | null | undefined, language: Language): string {
  if (!iso) return '—'
  const locale = language === 'en' ? 'en-US' : 'es-CO'
  return new Date(iso).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
}
