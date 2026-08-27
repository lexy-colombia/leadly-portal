/** Indicativos soportados -- lista corta a mano, no un catálogo exhaustivo
 * de +200 países, cubre los mercados donde opera la base de tenants hoy.
 * Colombia primero porque es el valor por defecto. Copiada del listado que
 * ya existía suelto en CampaignFormDrawer.tsx -- centralizada acá para que
 * el formulario de clientes y cualquier otro lugar usen la misma. */
export const DIAL_CODES = [
  { code: '57', label: 'Colombia (+57)' },
  { code: '1', label: 'Estados Unidos (+1)' },
  { code: '52', label: 'México (+52)' },
  { code: '34', label: 'España (+34)' },
  { code: '54', label: 'Argentina (+54)' },
  { code: '56', label: 'Chile (+56)' },
  { code: '51', label: 'Perú (+51)' },
  { code: '593', label: 'Ecuador (+593)' },
  { code: '58', label: 'Venezuela (+58)' },
  { code: '507', label: 'Panamá (+507)' },
  { code: '506', label: 'Costa Rica (+506)' },
] as const

export const DEFAULT_DIAL_CODE = DIAL_CODES[0].code

// Más largo primero -- si probáramos "1" antes que "593", un número
// ecuatoriano quedaría mal partido (todo excepto el "1" del medio como
// número local).
const DIAL_CODES_BY_LENGTH = [...DIAL_CODES].sort((a, b) => b.code.length - a.code.length)

/** Separa un teléfono guardado como un solo string sin separador (ej.
 * "573209149704" -- el mismo formato que manda Meta en wa_id, y el que usan
 * clients.phone/whatsapp_conversations.contact_phone) en indicativo + número
 * local. Si no matchea ningún indicativo conocido, devuelve
 * DEFAULT_DIAL_CODE y el string completo como número local -- nunca falla,
 * en el peor caso parte mal un país que no está en la lista. */
export function splitPhone(phone: string): { dialCode: string; localNumber: string } {
  const digits = (phone ?? '').replace(/\D/g, '')
  const match = DIAL_CODES_BY_LENGTH.find((c) => digits.startsWith(c.code))
  if (match) return { dialCode: match.code, localNumber: digits.slice(match.code.length) }
  return { dialCode: DEFAULT_DIAL_CODE, localNumber: digits }
}

/** Inverso de splitPhone -- lo que efectivamente se guarda en la base
 * (clients.phone), un solo string de dígitos sin separadores. */
export function combinePhone(dialCode: string, localNumber: string): string {
  return `${dialCode}${(localNumber ?? '').replace(/\D/g, '')}`
}

/** Agrupa el número local en bloques de a 3 (el último bloque se queda con
 * lo que sobre) para que se lea más fácil: "3209149704" -> "320 914 9704",
 * "2025551234" -> "202 555 1234". */
function groupDigits(digits: string): string {
  const groups: string[] = []
  let rest = digits
  while (rest.length > 4) {
    groups.push(rest.slice(0, 3))
    rest = rest.slice(3)
  }
  groups.push(rest)
  return groups.join(' ')
}

/** "573209149704" -> "+57 320 914 9704" -- para mostrar un teléfono
 * guardado de forma legible en vez del bloque de dígitos corrido tal cual
 * llega de WhatsApp (wa_id) o de un guardado manual sin separar. */
export function formatPhoneDisplay(phone: string | null | undefined): string {
  if (!phone) return ''
  const { dialCode, localNumber } = splitPhone(phone)
  if (!localNumber) return phone
  return `+${dialCode} ${groupDigits(localNumber)}`
}
