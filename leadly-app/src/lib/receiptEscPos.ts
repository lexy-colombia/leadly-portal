import { EscPosBuilder } from './escpos'
import { formatMoney } from '../components/pos/PosReceiptTicket'
import type { PosReceiptData } from './api/posReceipt'
import type { PosPendingReceiptData } from '../components/pos/PosPendingReceiptTicket'
import { PAYMENT_METHOD_LABEL_KEY } from './api/orderPayments'
import { formatDate, formatDateTime } from './dates'
import { formatClientPhoneDisplay } from './phone'
import type { TranslationKey, Language } from '../i18n/translations'

type T = (key: TranslationKey, params?: Record<string, string | number>) => string

/** Cabecera del negocio -- mismo orden de campos que
 * `.pos-receipt-header`/`.pos-receipt-doc` en PosReceiptTicket.tsx/
 * PosPendingReceiptTicket.tsx, sin el logo (rasterizarlo como bitmap ESC/
 * POS queda para una vuelta futura si hace falta -- el nombre del negocio
 * en doble tamaño ya lo deja bien visible). */
function writeHeader(b: EscPosBuilder, tenant: PosReceiptData['tenant']) {
  b.align('center')
  b.bold(true).doubleSize(true).line(tenant.name).doubleSize(false).bold(false)
  if (tenant.legal_name && tenant.legal_name !== tenant.name) b.line(tenant.legal_name)
  if (tenant.document_number) b.line(`${tenant.document_type ?? 'NIT'} ${tenant.document_number}`)
  if (tenant.billing_address) b.line(tenant.billing_address)
  b.align('left')
}

function writeItems(b: EscPosBuilder, items: { quantity: number; product_name: string; subtotal: number }[], currency: string) {
  for (const item of items) {
    b.row(`${item.quantity} ${item.product_name}`, formatMoney(item.subtotal, currency))
  }
}

/** Desglose de impuestos -- mismo criterio EXACTO que OrderTotalsSummary.tsx/
 * PosReceiptTicket.tsx: con impuesto discriminado la primera fila es la
 * base gravable, no el subtotal bruto (son números distintos). */
function writeTotals(
  b: EscPosBuilder,
  t: T,
  totals: PosReceiptData['totals'],
  currency: string,
) {
  if (totals.tax_lines.length > 0) {
    b.row(t('orders.totals.taxableBase'), formatMoney(totals.taxable_base, currency))
  } else {
    b.row(t('orders.totals.subtotal'), formatMoney(totals.subtotal, currency))
  }
  if (totals.discount_total > 0) b.row(t('orders.totals.discounts'), `-${formatMoney(totals.discount_total, currency)}`)
  for (const line of totals.tax_lines) {
    b.row(t('orders.totals.taxLine', { name: t('pos.receipt.tax'), rate: String(line.tax_rate) }), formatMoney(line.amount, currency))
  }
  if (totals.tax_lines.length === 0 && totals.tax_total > 0) b.row(t('orders.totals.genericTax'), formatMoney(totals.tax_total, currency))
  if (totals.shipping > 0) b.row(t('orders.totals.shipping'), formatMoney(totals.shipping, currency))
  b.rule()
  b.bold(true).row(t('orders.totals.total'), formatMoney(totals.total, currency)).bold(false)
}

/** Ticket final, cobrado -- mismo campo por campo que PosReceiptTicket.tsx,
 * con el QR nativo de la impresora en vez de rasterizar el PNG que ya
 * genera `posReceipt.ts` (se reusa el mismo `qrVerificationUrl`, la
 * impresora arma el símbolo ella misma desde ese string). */
export function buildChargedReceiptEscPos(data: PosReceiptData, t: T, language: Language, paperWidthMm: 58 | 80): Uint8Array {
  const { tenant, order, items, payments, totals, fiscal, posPointName } = data
  const currency = order.currency
  const b = new EscPosBuilder(paperWidthMm)

  writeHeader(b, tenant)
  b.rule()

  b.align('center')
  b.bold(true).line(fiscal.isRemision ? t('pos.receipt.docTitleDraft') : t('pos.receipt.docTitleInvoice')).bold(false)
  b.line(fiscal.documentLabel)
  if (!fiscal.isRemision && fiscal.resolution?.number) {
    b.line(`${t('pos.receipt.resolution')}: ${fiscal.resolution.number}`)
    if (fiscal.resolution.range_from != null && fiscal.resolution.range_to != null) {
      b.line(t('pos.receipt.resolutionRange', { prefix: fiscal.resolution.prefix ?? '', from: String(fiscal.resolution.range_from), to: String(fiscal.resolution.range_to) }))
    }
    if (fiscal.resolution.valid_from && fiscal.resolution.valid_until) {
      b.line(t('pos.receipt.resolutionValidity', { from: formatDate(fiscal.resolution.valid_from), until: formatDate(fiscal.resolution.valid_until) }))
    }
  }
  b.align('left')
  b.rule()

  b.row(t('pos.receipt.order'), `#${order.number}`)
  if (posPointName) b.row(t('pos.receipt.point'), posPointName)
  b.row(t('pos.receipt.date'), formatDateTime(order.created_at, language))
  if (order.created_by_profile) b.row(t('pos.receipt.cashier'), order.created_by_profile.full_name)

  if (order.contact) {
    b.rule()
    b.row(t('pos.receipt.client'), order.contact.full_name)
    if (order.contact.document_number) b.row(t('pos.receipt.document'), order.contact.document_number)
    if (order.contact.phone) b.row(t('pos.receipt.phone'), formatClientPhoneDisplay(order.contact.phone_prefix, order.contact.phone))
    const address = order.billing_address ?? order.shipping_address
    if (address) b.row(t('pos.receipt.address'), [address.line1, address.city, address.country].filter(Boolean).join(', '))
  }

  b.rule()
  writeItems(b, items, currency)
  b.rule()
  writeTotals(b, t, totals, currency)

  if (payments.length > 0) {
    b.rule()
    for (const p of payments) b.row(t(PAYMENT_METHOD_LABEL_KEY[p.method]), formatMoney(p.amount, p.currency))
  }

  if (!fiscal.isRemision) {
    b.rule()
    b.align('center')
    if (fiscal.isValidated && fiscal.cufe && fiscal.qrVerificationUrl) {
      b.qr(fiscal.qrVerificationUrl)
      b.feed(1)
      b.line(`CUFE: ${fiscal.cufe}`)
      b.line(t('pos.receipt.verifyHint'))
    } else {
      b.line(fiscal.status === 'rejected' || fiscal.status === 'error' ? t('pos.receipt.fiscalRejected') : t('pos.receipt.fiscalPending'))
    }
    b.align('left')
  }

  b.rule()
  b.align('center')
  b.line(tenant.pos_receipt_footer_message || t('pos.receipt.defaultFooter'))
  if (fiscal.isRemision) b.line(t('pos.receipt.disclaimer'))
  b.align('left')

  b.cut()
  return b.toBytes()
}

/** Vista previa de "lo que tengo cargado", antes de cobrar -- mismo campo
 * por campo que PosPendingReceiptTicket.tsx. Nunca lleva QR/CUFE/
 * resolución: no existe pedido ni pago todavía. */
export function buildPendingReceiptEscPos(data: PosPendingReceiptData, t: T, language: Language, paperWidthMm: 58 | 80): Uint8Array {
  const { tenant, items, totals, posPointName, customerName } = data
  const currency = 'COP'
  const b = new EscPosBuilder(paperWidthMm)

  writeHeader(b, tenant)
  b.rule()

  b.align('center')
  b.bold(true).line(t('pos.receipt.docTitlePending')).bold(false)
  b.align('left')
  b.rule()

  if (posPointName) b.row(t('pos.receipt.point'), posPointName)
  b.row(t('pos.receipt.date'), formatDateTime(new Date().toISOString(), language))
  if (customerName) b.row(t('pos.receipt.client'), customerName)

  b.rule()
  writeItems(b, items, currency)
  b.rule()
  writeTotals(b, t, totals, currency)

  b.rule()
  b.align('center')
  b.line(t('pos.receipt.pendingDisclaimer'))
  b.align('left')

  b.cut()
  return b.toBytes()
}
