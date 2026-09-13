import { useEffect, useState, type ReactNode } from 'react'
import { getTenant } from './api/tenants'
import type { Tenant } from '../types/domain'
import type { ExpenseWithRelations } from './api/expenses'
import { ReceiptPrintPortal } from '../components/pos/ReceiptPrintPortal'
import { ExpenseReceiptTicket } from '../components/expenses/ExpenseReceiptTicket'
import { useLanguage } from '../contexts/LanguageContext'
import { buildExpenseReceiptEscPos } from './receiptEscPos'
import { printRaw } from './webUsbPrinter'

/** Imprime el comprobante de un egreso, con el MISMO mecanismo que el ticket
 * del POS (ver usePosReceiptPrinter): si el comercio tiene la impresión
 * directa por WebUSB activada, se manda ESC/POS a la térmica; si no, se
 * monta el ticket en un portal y se dispara el diálogo de impresión del
 * sistema. El caller monta `portal` una vez en su JSX y llama `print(gasto)`.
 *
 * A diferencia del POS, no hace falta cargar nada del servidor: la fila del
 * gasto que ya está en pantalla trae todo lo que el papel necesita
 * (proveedor y categoría vienen embebidos, ver EXPENSE_SELECT). Lo único que
 * se resuelve aparte es el tenant, para el encabezado y el logo. */
export function useExpenseReceiptPrinter(tenantId: string | null | undefined) {
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

  async function print(expense: ExpenseWithRelations) {
    if (!tenantId) return
    setPrinting(true)
    setError(null)
    try {
      const resolvedTenant = tenant ?? (await getTenant(tenantId))
      if (!resolvedTenant) throw new Error(t('expenses.receipt.errors.print'))
      setTenant(resolvedTenant)
      const data = { tenant: resolvedTenant, expense }
      if (resolvedTenant.pos_receipt_use_webusb) {
        const widthMm = resolvedTenant.pos_receipt_paper_width === '58mm' ? 58 : 80
        await printRaw(await buildExpenseReceiptEscPos(data, t, language, widthMm))
        return
      }
      setPortal(
        <ReceiptPrintPortal paperWidth={resolvedTenant.pos_receipt_paper_width} onDone={() => setPortal(null)}>
          <ExpenseReceiptTicket data={data} />
        </ReceiptPrintPortal>,
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : t('expenses.receipt.errors.print'))
    } finally {
      setPrinting(false)
    }
  }

  return { print, printing, error, portal }
}
