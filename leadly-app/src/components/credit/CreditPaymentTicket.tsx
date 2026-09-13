import type { Client, CreditPayment, Tenant } from '../../types/domain'
import { CREDIT_PAYMENT_METHOD_LABEL_KEY } from '../../lib/api/credit'
import { formatDate, formatDateTime } from '../../lib/dates'
import { formatClientPhoneDisplay } from '../../lib/phone'
import { useLanguage } from '../../contexts/LanguageContext'
import { MetaRow, formatMoney } from '../pos/PosReceiptTicket'

export interface CreditPaymentTicketData {
  tenant: Tenant
  client: Client
  payment: CreditPayment
  /** Saldo del cliente al momento de imprimir -- se pasa desde la pantalla,
   * que ya lo tiene calculado (cargos menos abonos). Va rotulado como "saldo
   * actual" y no "saldo después de este abono": un abono viejo reimpreso hoy
   * no puede afirmar cuál era el saldo aquel día. */
  balance: number
}

/** Soporte de pago (abono a crédito) en papel térmico -- mismo lenguaje
 * visual que el ticket del POS, reusando sus clases `pos-receipt-*` y
 * ReceiptPrintPortal.
 *
 * Es el comprobante que se le entrega al cliente cuando abona a su cuenta,
 * no un documento fiscal: sin resolución, sin CUFE, sin QR, con la leyenda
 * del pie. Mismo criterio que `isRemision` en el ticket de venta. */
export function CreditPaymentTicket({ data }: { data: CreditPaymentTicketData }) {
  const { t, language } = useLanguage()
  const { tenant, client, payment, balance } = data

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
        {tenant.contact_phone && (
          <p>
            {t('pos.receipt.phone')}: {tenant.contact_phone}
          </p>
        )}
      </div>

      <div className="pos-receipt-rule" />

      <div className="pos-receipt-doc">
        <p className="pos-receipt-doc-title">{t('credit.ticket.docTitle')}</p>
        <p>{t('credit.movement.receipt', { number: payment.receipt_number })}</p>
      </div>

      <div className="pos-receipt-rule" />

      <div className="pos-receipt-meta">
        <MetaRow label={t('credit.ticket.client')} value={client.full_name} />
        {client.document_number && <MetaRow label={t('credit.ticket.document')} value={client.document_number} />}
        {client.phone && <MetaRow label={t('pos.receipt.phone')} value={formatClientPhoneDisplay(client.phone_prefix, client.phone)} />}
        <MetaRow label={t('credit.ticket.date')} value={formatDate(payment.paid_at)} />
        <MetaRow label={t('credit.ticket.method')} value={t(CREDIT_PAYMENT_METHOD_LABEL_KEY[payment.method])} />
      </div>

      {payment.notes && (
        <>
          <div className="pos-receipt-rule" />
          <div className="pos-receipt-items">
            <p>{t('credit.ticket.notes')}</p>
            <p>{payment.notes}</p>
          </div>
        </>
      )}

      <div className="pos-receipt-rule" />

      <p className="pos-receipt-total-line">
        <span>{t('credit.ticket.amount')}</span>
        <span>{formatMoney(payment.amount, payment.currency)}</span>
      </p>

      <div className="pos-receipt-totals">
        <MetaRow label={t('credit.ticket.balance')} value={formatMoney(balance, payment.currency)} />
      </div>

      <div className="pos-receipt-rule" />

      <p className="pos-receipt-footer">{t('credit.ticket.disclaimer')}</p>
      <p className="pos-receipt-footer">{formatDateTime(new Date().toISOString(), language)}</p>
    </div>
  )
}
