import type { OrderTotalsBreakdown } from '../../lib/api/orders'
import type { Tenant } from '../../types/domain'
import { formatDateTime } from '../../lib/dates'
import { useLanguage } from '../../contexts/LanguageContext'
import { MetaRow, formatMoney } from './PosReceiptTicket'

export interface PosPendingReceiptItem {
  product_name: string
  sku: string | null
  quantity: number
  subtotal: number
}

export interface PosPendingReceiptData {
  tenant: Tenant
  items: PosPendingReceiptItem[]
  totals: OrderTotalsBreakdown
  posPointName: string | null
  customerName: string | null
}

/** Ticket de "lo que tengo cargado" -- se imprime ANTES de cobrar (pedido
 * explícito del usuario: hasta ahora solo se podía imprimir después de
 * registrar el pago). Nunca pasa por loadPosReceiptData/PosReceiptTicket:
 * no existe ni pedido ni pago todavía, así que no puede llevar número de
 * documento, resolución DIAN, CUFE ni "Factura electrónica de venta" --
 * mostrar cualquiera de esos sería aparentar un comprobante que todavía no
 * existe. Es siempre y únicamente una vista previa de la cuenta. */
export function PosPendingReceiptTicket({ data }: { data: PosPendingReceiptData }) {
  const { t, language } = useLanguage()
  const { tenant, items, totals, posPointName, customerName } = data
  const currency = 'COP'

  return (
    <div className="pos-receipt-ticket">
      <div className="pos-receipt-header">
        {tenant.logo_url && <img src={tenant.logo_url} alt="" className="pos-receipt-logo" />}
        <p className="pos-receipt-business-name">{tenant.name}</p>
        {tenant.legal_name && tenant.legal_name !== tenant.name && <p className="pos-receipt-legal-name">{tenant.legal_name}</p>}
        {tenant.document_number && (
          <p>
            {tenant.document_type ?? 'NIT'} {tenant.document_number}
          </p>
        )}
        {tenant.billing_address && <p>{tenant.billing_address}</p>}
        {tenant.contact_phone && <p>{t('pos.receipt.phone')}: {tenant.contact_phone}</p>}
      </div>

      <div className="pos-receipt-rule" />

      <div className="pos-receipt-doc">
        <p className="pos-receipt-doc-title">{t('pos.receipt.docTitlePending')}</p>
      </div>

      <div className="pos-receipt-rule" />

      <div className="pos-receipt-meta">
        {posPointName && <MetaRow label={t('pos.receipt.point')} value={posPointName} />}
        <MetaRow label={t('pos.receipt.date')} value={formatDateTime(new Date().toISOString(), language)} />
        {customerName && <MetaRow label={t('pos.receipt.client')} value={customerName} />}
      </div>

      <div className="pos-receipt-rule" />

      <div className="pos-receipt-items">
        {items.map((item, index) => (
          <div key={index} className="pos-receipt-item">
            <div className="flex justify-between gap-2">
              <span>
                {item.quantity} {item.product_name}
              </span>
              <span className="shrink-0">{formatMoney(item.subtotal, currency)}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="pos-receipt-rule" />

      {/* Mismo criterio EXACTO que OrderTotalsSummary.tsx y PosReceiptTicket
          -- con impuesto discriminado, la primera fila es la base gravable
          (`taxable_base`), no el subtotal bruto. Ver el comentario grande
          en PosReceiptTicket.tsx para el bug real que esto corrige. */}
      <div className="pos-receipt-totals">
        {totals.tax_lines.length > 0 ? (
          <MetaRow label={t('orders.totals.taxableBase')} value={formatMoney(totals.taxable_base, currency)} />
        ) : (
          <MetaRow label={t('orders.totals.subtotal')} value={formatMoney(totals.subtotal, currency)} />
        )}
        {totals.discount_total > 0 && <MetaRow label={t('orders.totals.discounts')} value={`-${formatMoney(totals.discount_total, currency)}`} />}
        {totals.tax_lines.map((line) => (
          <MetaRow
            key={`${line.tax_type_code ?? ''}:${line.tax_rate}`}
            label={t('orders.totals.taxLine', { name: t('pos.receipt.tax'), rate: String(line.tax_rate) })}
            value={formatMoney(line.amount, currency)}
          />
        ))}
        {totals.tax_lines.length === 0 && totals.tax_total > 0 && <MetaRow label={t('orders.totals.genericTax')} value={formatMoney(totals.tax_total, currency)} />}
        {totals.shipping > 0 && <MetaRow label={t('orders.totals.shipping')} value={formatMoney(totals.shipping, currency)} />}
      </div>

      <div className="pos-receipt-rule" />

      <p className="pos-receipt-total-line">
        <span>{t('orders.totals.total')}</span>
        <span>{formatMoney(totals.total, currency)}</span>
      </p>

      <div className="pos-receipt-rule" />

      <p className="pos-receipt-footer">{t('pos.receipt.pendingDisclaimer')}</p>
    </div>
  )
}
