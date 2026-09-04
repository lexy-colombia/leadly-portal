import type { PosReceiptData } from '../../lib/api/posReceipt'
import { PAYMENT_METHOD_LABEL_KEY } from '../../lib/api/orderPayments'
import { formatDate, formatDateTime } from '../../lib/dates'
import { useLanguage } from '../../contexts/LanguageContext'

function formatMoney(value: number, currency: string): string {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value)
}

/** Fila etiqueta:valor del encabezado -- mismo criterio en toda la app
 * (StatusDotLine, etc.), acá reducido a texto plano porque en papel
 * térmico no hay color, solo blanco y negro. */
function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2">
      <span>{label}</span>
      <span className="text-right">{value}</span>
    </div>
  )
}

/** El ticket en sí -- sin nada de layout de impresión (eso lo resuelve
 * ReceiptPrintPortal, que es quien decide CUÁNDO y CÓMO se imprime). Este
 * componente solo sabe pintar el papel: encabezado del negocio, título +
 * resolución DIAN (solo si el tenant tiene facturación electrónica activa,
 * ver `fiscal` en posReceipt.ts), meta del pedido, líneas, desglose de
 * impuestos (mismos números que ya muestra OrderTotalsSummary en el resto
 * de la app, solo que en texto plano), CUFE + QR de verificación cuando la
 * DIAN ya aceptó el documento, y pie. Mismo criterio EXACTO que el PDF
 * descargable (sales-invoice-pdf) -- ver el comentario de PosReceiptFiscalData
 * en posReceipt.ts: sin DIAN activa, es un borrador interno ("Remisión",
 * pedido explícito del usuario); con DIAN activa y el documento ya
 * aceptado, es el mismo documento fiscal que el PDF, solo que en 58/80mm. */
export function PosReceiptTicket({ data }: { data: PosReceiptData }) {
  const { t, language } = useLanguage()
  const { tenant, order, items, payments, totals, fiscal, posPointName } = data
  const currency = order.currency

  return (
    <div className="pos-receipt-ticket">
      <div className="pos-receipt-header">
        {tenant.logo_url && <img src={tenant.logo_url} alt="" className="pos-receipt-logo" />}
        <p className="pos-receipt-business-name">{tenant.name}</p>
        {tenant.document_number && (
          <p>
            {tenant.document_type ?? 'NIT'} {tenant.document_number}
          </p>
        )}
        {tenant.billing_address && <p>{tenant.billing_address}</p>}
        {tenant.contact_phone && <p>{t('pos.receipt.phone')}: {tenant.contact_phone}</p>}
      </div>

      <div className="pos-receipt-rule" />

      {/* Título del documento -- "Remisión" (borrador, sin efecto fiscal) o
          el mismo rótulo que usa el PDF cuando la DIAN factura electrónica
          está activa, con su número real y la resolución vigente debajo,
          igual que exige el Anexo Técnico. */}
      <div className="pos-receipt-doc">
        <p className="pos-receipt-doc-title">{fiscal.isRemision ? t('pos.receipt.docTitleDraft') : t('pos.receipt.docTitleInvoice')}</p>
        <p className="pos-receipt-doc-number">{fiscal.documentLabel}</p>
        {!fiscal.isRemision && fiscal.resolution?.number && (
          <>
            <p>
              {t('pos.receipt.resolution')}: {fiscal.resolution.number}
            </p>
            {fiscal.resolution.range_from != null && fiscal.resolution.range_to != null && (
              <p>
                {t('pos.receipt.resolutionRange', {
                  prefix: fiscal.resolution.prefix ?? '',
                  from: String(fiscal.resolution.range_from),
                  to: String(fiscal.resolution.range_to),
                })}
              </p>
            )}
            {fiscal.resolution.valid_from && fiscal.resolution.valid_until && (
              <p>
                {t('pos.receipt.resolutionValidity', { from: formatDate(fiscal.resolution.valid_from), until: formatDate(fiscal.resolution.valid_until) })}
              </p>
            )}
          </>
        )}
      </div>

      <div className="pos-receipt-rule" />

      <div className="pos-receipt-meta">
        <MetaRow label={t('pos.receipt.order')} value={`#${order.number}`} />
        {posPointName && <MetaRow label={t('pos.receipt.point')} value={posPointName} />}
        <MetaRow label={t('pos.receipt.date')} value={formatDateTime(order.created_at, language)} />
        {order.created_by_profile && <MetaRow label={t('pos.receipt.cashier')} value={order.created_by_profile.full_name} />}
        {order.contact && <MetaRow label={t('pos.receipt.client')} value={order.contact.full_name} />}
      </div>

      <div className="pos-receipt-rule" />

      <div className="pos-receipt-items">
        {items.map((item) => (
          <div key={item.id} className="pos-receipt-item">
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

      <div className="pos-receipt-totals">
        <MetaRow label={t('orders.totals.subtotal')} value={formatMoney(totals.subtotal, currency)} />
        {totals.discount_total > 0 && <MetaRow label={t('orders.totals.discounts')} value={`-${formatMoney(totals.discount_total, currency)}`} />}
        {totals.tax_lines.length > 0 ? (
          totals.tax_lines.map((line) => (
            <MetaRow
              key={`${line.tax_type_code ?? ''}:${line.tax_rate}`}
              label={t('orders.totals.taxLine', { name: t('pos.receipt.tax'), rate: String(line.tax_rate) })}
              value={formatMoney(line.amount, currency)}
            />
          ))
        ) : (
          <MetaRow label={t('pos.receipt.exempt')} value={formatMoney(totals.taxable_base, currency)} />
        )}
        {totals.shipping > 0 && <MetaRow label={t('orders.totals.shipping')} value={formatMoney(totals.shipping, currency)} />}
      </div>

      <div className="pos-receipt-rule" />

      <p className="pos-receipt-total-line">
        <span>{t('orders.totals.total')}</span>
        <span>{formatMoney(totals.total, currency)}</span>
      </p>

      {payments.length > 0 && (
        <>
          <div className="pos-receipt-rule" />
          <div className="pos-receipt-payments">
            {payments.map((p) => (
              <MetaRow key={p.id} label={t(PAYMENT_METHOD_LABEL_KEY[p.method])} value={formatMoney(p.amount, p.currency)} />
            ))}
          </div>
        </>
      )}

      {/* Bloque fiscal -- solo existe cuando el tenant factura electrónico
          (ver PosReceiptFiscalData). Antes de que la DIAN acepte el
          documento, el CUFE ya se calculó pero mostrarlo (o peor, un QR
          apuntando al catálogo real) sería aparentar un documento
          verificable que todavía no lo es -- mismo criterio que el PDF, se
          avisa el estado en texto llano en vez de eso. */}
      {!fiscal.isRemision && (
        <>
          <div className="pos-receipt-rule" />
          <div className="pos-receipt-fiscal">
            {fiscal.isValidated && fiscal.cufe ? (
              <>
                <p className="pos-receipt-cufe">CUFE: {fiscal.cufe}</p>
                {fiscal.qrDataUrl && <img src={fiscal.qrDataUrl} alt="" className="pos-receipt-qr" />}
                <p>{t('pos.receipt.verifyHint')}</p>
              </>
            ) : (
              <p>{fiscal.status === 'rejected' || fiscal.status === 'error' ? t('pos.receipt.fiscalRejected') : t('pos.receipt.fiscalPending')}</p>
            )}
          </div>
        </>
      )}

      <div className="pos-receipt-rule" />

      <p className="pos-receipt-footer">{tenant.pos_receipt_footer_message || t('pos.receipt.defaultFooter')}</p>
      {fiscal.isRemision && <p className="pos-receipt-disclaimer">{t('pos.receipt.disclaimer')}</p>}
    </div>
  )
}
