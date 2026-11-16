/** Un valor guardado como texto libre («Colombia») se lee como su código ISO
 * para poder preseleccionarlo; cualquier otro texto se conserva tal cual. */
export function normalizeCountryValue(value: string | null | undefined): string {
  const raw = (value ?? '').trim()
  if (!raw) return ''
  if (/^[A-Za-z]{2}$/.test(raw)) return raw.toUpperCase()
  return raw.toLowerCase() === 'colombia' ? 'CO' : raw
}

