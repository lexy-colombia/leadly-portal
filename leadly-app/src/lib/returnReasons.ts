import type { ReturnReason } from '../types/domain'
import type { TranslationKey } from '../i18n/translations'

/** Constante fija a propósito -- pedido explícito del usuario (2026-08-23):
 * a diferencia de ReturnStatus/ReturnResolutionType, el motivo de una
 * devolución NO es un catálogo configurable por tenant. Mismo orden que el
 * CHECK constraint de `returns.reason` en la migración. */
export const RETURN_REASONS: ReturnReason[] = ['danado', 'equivocado', 'no_esperado', 'no_le_gusto', 'otro']

export const RETURN_REASON_LABEL_KEY: Record<ReturnReason, TranslationKey> = {
  danado: 'returns.reason.danado',
  equivocado: 'returns.reason.equivocado',
  no_esperado: 'returns.reason.no_esperado',
  no_le_gusto: 'returns.reason.no_le_gusto',
  otro: 'returns.reason.otro',
}
