import { formatDate } from './dates'
import type { CustomFieldDefinition, CustomFieldType } from '../types/domain'

/** Helpers de PRESENTACIÓN de campos personalizados. No validan nada: la
 * única validación es el trigger de `clients` en la base (el front solo
 * envía y muestra el error que devuelva). */

export type CustomFieldOperator = 'contains' | 'eq' | 'gt' | 'lt' | 'before' | 'after'

const OPERATORS: Record<CustomFieldType, CustomFieldOperator[]> = {
  text: ['contains', 'eq'],
  integer: ['eq', 'gt', 'lt'],
  decimal: ['eq', 'gt', 'lt'],
  date: ['eq', 'before', 'after'],
  boolean: ['eq'],
  select: ['eq'],
}

export function operatorsFor(type: CustomFieldType): CustomFieldOperator[] {
  return OPERATORS[type]
}

/** Valor del input -> valor JSON para enviar. Vacío = sin valor (`null`).
 * Para números se envía el número; si el texto no se puede leer como número
 * se envía tal cual y es el servidor quien lo rechaza con su mensaje. */
export function inputToPayload(type: CustomFieldType, raw: string | boolean | undefined): unknown {
  if (raw === undefined) return null
  if (typeof raw === 'boolean') return raw
  const text = type === 'text' ? raw : raw.trim()
  if (text === '') return null
  if (type === 'integer' || type === 'decimal') {
    const n = Number(text)
    return Number.isFinite(n) ? n : text
  }
  return text
}

/** Valor guardado -> estado del input del formulario. */
export function payloadToInput(type: CustomFieldType, value: unknown): string | boolean | undefined {
  if (value === null || value === undefined) return type === 'boolean' ? undefined : ''
  if (type === 'boolean') return value === true ? true : value === false ? false : undefined
  return String(value)
}

export function hasCustomFieldValue(value: unknown): boolean {
  return value !== null && value !== undefined && value !== ''
}

/** Texto para mostrar en ficha/listado. `labels` trae los textos de sí/no. */
export function formatCustomFieldValue(
  def: CustomFieldDefinition,
  value: unknown,
  labels: { yes: string; no: string },
  locale: string,
): string {
  if (!hasCustomFieldValue(value)) return '—'
  switch (def.field_type) {
    case 'boolean':
      return value === true ? labels.yes : value === false ? labels.no : String(value)
    case 'date':
      return formatDate(String(value))
    case 'integer':
    case 'decimal': {
      const n = Number(value)
      return Number.isFinite(n) ? n.toLocaleString(locale, { maximumFractionDigits: 6 }) : String(value)
    }
    default:
      return String(value)
  }
}

/** Evaluación del filtro del listado, en memoria sobre las filas ya cargadas.
 * Un operando vacío significa "sin filtro". */
export function matchesCustomFieldFilter(
  def: CustomFieldDefinition,
  value: unknown,
  operator: CustomFieldOperator,
  operand: string,
): boolean {
  const target = operand.trim()
  if (target === '') return true
  if (!hasCustomFieldValue(value)) return false
  switch (def.field_type) {
    case 'text':
      return operator === 'contains'
        ? String(value).toLowerCase().includes(target.toLowerCase())
        : String(value).toLowerCase() === target.toLowerCase()
    case 'integer':
    case 'decimal': {
      const a = Number(value)
      const b = Number(target)
      if (operator === 'gt') return a > b
      if (operator === 'lt') return a < b
      return a === b
    }
    case 'date': {
      // "YYYY-MM-DD" ordena igual como texto que como fecha.
      const a = String(value)
      if (operator === 'before') return a < target
      if (operator === 'after') return a > target
      return a === target
    }
    case 'boolean':
      return String(value) === target
    default:
      return String(value) === target
  }
}
