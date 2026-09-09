import type { CreditNoteReasonCode } from '../types/domain'
import type { TranslationKey } from '../i18n/translations'

/** Constante fija a propósito, mismo criterio que RETURN_REASONS -- el
 * motivo de una nota crédito no es un catálogo configurable por tenant, son
 * los 6 códigos fijos de cac:DiscrepancyResponse/cbc:ResponseCode del Anexo
 * Técnico DIAN v1.9 (tabla 13.2.4, "Caja de Herramientas"). Mismo orden que
 * el CHECK constraint de `sales_credit_notes.reason_code`. */
export const CREDIT_NOTE_REASONS: CreditNoteReasonCode[] = ['1', '2', '3', '4', '5', '6']

export const CREDIT_NOTE_REASON_LABEL_KEY: Record<CreditNoteReasonCode, TranslationKey> = {
  '1': 'einvoicing.creditNote.reason.1',
  '2': 'einvoicing.creditNote.reason.2',
  '3': 'einvoicing.creditNote.reason.3',
  '4': 'einvoicing.creditNote.reason.4',
  '5': 'einvoicing.creditNote.reason.5',
  '6': 'einvoicing.creditNote.reason.6',
}
