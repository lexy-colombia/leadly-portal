import { useEffect, useState, type ReactNode } from 'react'
import { getTenant } from './api/tenants'
import type { Client, CreditPayment, Tenant } from '../types/domain'
import { ReceiptPrintPortal } from '../components/pos/ReceiptPrintPortal'
import { CreditPaymentTicket } from '../components/credit/CreditPaymentTicket'
import { useLanguage } from '../contexts/LanguageContext'
import { buildCreditPaymentReceiptEscPos } from './receiptEscPos'
import { printRaw } from './webUsbPrinter'

/** Imprime el soporte de pago de un abono a crédito, con el MISMO mecanismo
 * que el ticket del POS (ver usePosReceiptPrinter): WebUSB directo si el
 * comercio lo tiene activado, si no el diálogo de impresión del sistema. El
 * caller monta `portal` una vez en su JSX y llama `print(...)`.
 *
 * No carga nada del servidor: el abono, el cliente y el saldo ya están en
 * pantalla. Lo único que se resuelve aparte es el tenant, para el
 * encabezado y el logo. */
export function useCreditPaymentReceiptPrinter(tenantId: string | null | undefined) {
  const { t, language } = useLanguage()
  const [printing, setPrinting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [portal, setPortal] = useState<ReactNode>(null)
  const [tenant, setTenant] = useState<Tenant | null>(null)

  useEffect(() => {
    if (!tenantId) return
    getTenant(tenantId)
      .then(setTenant)
      .catch(() => setTenant(null))
  }, [tenantId])

  async function print(payment: CreditPayment, client: Client, balance: number) {
    if (!tenantId) return
    setPrinting(true)
    setError(null)
    try {
      const resolvedTenant = tenant ?? (await getTenant(tenantId))
      if (!resolvedTenant) throw new Error(t('credit.ticket.errors.print'))
      setTenant(resolvedTenant)
      const data = { tenant: resolvedTenant, client, payment, balance }
      if (resolvedTenant.pos_receipt_use_webusb) {
        const widthMm = resolvedTenant.pos_receipt_paper_width === '58mm' ? 58 : 80
        await printRaw(await buildCreditPaymentReceiptEscPos(data, t, language, widthMm))
        return
      }
      setPortal(
        <ReceiptPrintPortal paperWidth={resolvedTenant.pos_receipt_paper_width} onDone={() => setPortal(null)}>
          <CreditPaymentTicket data={data} />
        </ReceiptPrintPortal>,
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : t('credit.ticket.errors.print'))
    } finally {
      setPrinting(false)
    }
  }

  return { print, printing, error, portal }
}
