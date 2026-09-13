import type { ExpenseStatus, Tenant } from '../../types/domain'
import type { ExpenseWithRelations } from '../../lib/api/expenses'
import type { TranslationKey } from '../../i18n/translations'
import { formatDate, formatDateTime } from '../../lib/dates'
import { useLanguage } from '../../contexts/LanguageContext'
import { MetaRow, formatMoney } from '../pos/PosReceiptTicket'

export interface ExpenseReceiptData {
  tenant: Tenant
  expense: ExpenseWithRelations
}

/** Mismas etiquetas que la tabla de Gastos -- el papel no puede decir algo
 * distinto de la pantalla. */
export const EXPENSE_STATUS_LABEL_KEY: Record<ExpenseStatus, TranslationKey> = {
  pendiente: 'expenses.list.status.pendiente',
  pagado: 'expenses.list.status.pagado',
  anulado: 'expenses.list.status.anulado',
}

/** Etiqueta del comprobante: EGR-123. El consecutivo es por comercio (ver
 * la migración 20260913200000) -- sin él, dos gastos del mismo día al mismo
 * proveedor serían indistinguibles en el papel. */
export function expenseDocumentLabel(expense: { number: number }): string {
  return `EGR-${expense.number}`
}

/** Comprobante de egreso en papel térmico -- mismo lenguaje visual que el
 * ticket del POS (reusa sus clases `pos-receipt-*` y ReceiptPrintPortal, que
 * es quien decide CUÁNDO y CÓMO se imprime).
 *
 * Deliberadamente NO se parece a una factura: un egreso es un documento
 * INTERNO de control (quién recibió cuánto y por qué concepto), no un
 * documento fiscal. Por eso no lleva resolución, ni CUFE, ni QR, y sí lleva
 * la leyenda del pie y el espacio de firma de quien recibe -- mismo criterio
 * que `isRemision` en el ticket de venta: nunca aparentar un comprobante que
 * no existe. */
export function ExpenseReceiptTicket({ data }: { data: ExpenseReceiptData }) {
  const { t, language } = useLanguage()
  const { tenant, expense } = data

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
        <p className="pos-receipt-doc-title">{t('expenses.receipt.docTitle')}</p>
        <p>{expenseDocumentLabel(expense)}</p>
      </div>

      <div className="pos-receipt-rule" />

      <div className="pos-receipt-meta">
        <MetaRow label={t('expenses.receipt.date')} value={formatDate(expense.expense_date)} />
        {expense.payment_date && <MetaRow label={t('expenses.receipt.paymentDate')} value={formatDate(expense.payment_date)} />}
        <MetaRow label={t('expenses.receipt.supplier')} value={expense.supplier?.name ?? '—'} />
        <MetaRow label={t('expenses.receipt.category')} value={expense.category?.name ?? '—'} />
        {expense.payment_method && <MetaRow label={t('expenses.receipt.method')} value={expense.payment_method} />}
        <MetaRow label={t('expenses.receipt.status')} value={t(EXPENSE_STATUS_LABEL_KEY[expense.status])} />
      </div>

      {expense.description && (
        <>
          <div className="pos-receipt-rule" />
          <div className="pos-receipt-items">
            <p>{t('expenses.receipt.concept')}</p>
            <p>{expense.description}</p>
          </div>
        </>
      )}

      <div className="pos-receipt-rule" />

      <p className="pos-receipt-total-line">
        <span>{t('expenses.receipt.amount')}</span>
        <span>{formatMoney(expense.amount, expense.currency)}</span>
      </p>

      <div className="pos-receipt-rule" />

      {/* Espacio de firma: es lo que convierte al papel en un comprobante de
          entrega real -- quien recibe la plata firma acá. */}
      <div className="pos-receipt-meta">
        <p>{t('expenses.receipt.signature')}</p>
        <p>&nbsp;</p>
        <p>______________________________</p>
        <p>{t('expenses.receipt.signatureName')}</p>
      </div>

      <div className="pos-receipt-rule" />

      <p className="pos-receipt-footer">{t('expenses.receipt.disclaimer')}</p>
      <p className="pos-receipt-footer">{formatDateTime(new Date().toISOString(), language)}</p>
    </div>
  )
}
