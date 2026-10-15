// Origen del valor de cada variable ({{1}}, {{2}}...) de una plantilla de
// campaña: un campo de la ficha del cliente, un campo personalizado, o texto
// libre (que se escribe a mano por contacto o como un mismo valor para todos).

export type StandardClientField = 'full_name' | 'first_name' | 'email' | 'company' | 'phone' | 'document_number'

export type VariableSource =
  | { kind: 'free' }
  | { kind: 'field'; field: StandardClientField }
  | { kind: 'custom'; definitionId: string }

export const STANDARD_CLIENT_FIELDS: StandardClientField[] = ['full_name', 'first_name', 'email', 'company', 'phone', 'document_number']

export const FREE_SOURCE: VariableSource = { kind: 'free' }

/** Subconjunto de la ficha que hace falta para resolver una variable. */
export interface VariableClient {
  full_name: string
  phone_prefix: string
  phone: string
  email: string | null
  company: string | null
  document_number: string | null
  custom_fields: Record<string, unknown> | null
}

/** Codifica/decodifica la fuente como string para usarla como value de un Select. */
export function encodeSource(source: VariableSource): string {
  if (source.kind === 'field') return `field:${source.field}`
  if (source.kind === 'custom') return `custom:${source.definitionId}`
  return 'free'
}

export function decodeSource(value: string): VariableSource {
  if (value.startsWith('field:')) {
    const field = value.slice(6) as StandardClientField
    if (STANDARD_CLIENT_FIELDS.includes(field)) return { kind: 'field', field }
  }
  if (value.startsWith('custom:')) return { kind: 'custom', definitionId: value.slice(7) }
  return FREE_SOURCE
}

/** Valor de la variable para un cliente. Devuelve '' si el dato no existe:
 * la validación del formulario lo marca como faltante en vez de mandar
 * "null"/"undefined" al cliente por WhatsApp. */
export function resolveVariable(source: VariableSource, client: VariableClient): string {
  if (source.kind === 'free') return ''
  if (source.kind === 'field') {
    switch (source.field) {
      case 'full_name':
        return client.full_name.trim()
      case 'first_name':
        return client.full_name.trim().split(/\s+/)[0] ?? ''
      case 'email':
        return (client.email ?? '').trim()
      case 'company':
        return (client.company ?? '').trim()
      case 'phone':
        return `${client.phone_prefix}${client.phone}`.replace(/\D/g, '')
      case 'document_number':
        return (client.document_number ?? '').trim()
    }
  }
  const value = client.custom_fields?.[source.definitionId]
  if (value === null || value === undefined) return ''
  if (typeof value === 'boolean') return value ? 'Sí' : 'No'
  return String(value).trim()
}
