import { useEffect, useState, type ReactNode } from 'react'
import { loadPosReceiptData } from './api/posReceipt'
import type { OrderTotalsBreakdown } from './api/orders'
import { getTenant } from './api/tenants'
import type { Tenant } from '../types/domain'
import { ReceiptPrintPortal } from '../components/pos/ReceiptPrintPortal'
import { PosReceiptTicket } from '../components/pos/PosReceiptTicket'
import { PosPendingReceiptTicket, type PosPendingReceiptItem } from '../components/pos/PosPendingReceiptTicket'
import { useLanguage } from '../contexts/LanguageContext'
import { buildChargedReceiptEscPos, buildPendingReceiptEscPos } from './receiptEscPos'
import { printRaw } from './webUsbPrinter'

/** Único punto de entrada para imprimir un ticket POS desde cualquier
 * pantalla (venta rápida, cuenta abierta, listado, detalle de la orden) --
 * pedido explícito del usuario: un hook, no un componente nuevo por
 * pantalla. `print(orderId)` carga todo lo que hace falta (tenant, pedido,
 * ítems, pagos, desglose de impuestos -- ver loadPosReceiptData) y renderiza
 * `portal` en el árbol, que dispara el diálogo de impresión del sistema
 * solo. `printPending(items, totals, ...)` es la variante que pidió el
 * usuario para imprimir la cuenta ANTES de cobrar -- no depende de que
 * exista un pedido, solo del tenant (para el encabezado/logo) y de lo que
 * ya está cargado en pantalla, ver PosPendingReceiptTicket. El caller monta
 * `portal` una vez en su JSX y listo -- no necesita saber nada de cómo se
 * arma ninguno de los dos tickets. */
export function usePosReceiptPrinter(tenantId: string | null | undefined) {
  const { t, language } = useLanguage()
  const [printing, setPrinting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [portal, setPortal] = useState<ReactNode>(null)
  // Se resuelve una vez, aparte de print(), para que la pantalla sepa SI
  // debe llamar a print() automáticamente apenas se cobra -- sin esto,
  // decidir "auto-imprimir o no" habría significado cargar el tenant
  // completo en cada pantalla del POS solo por este flag.
  const [tenant, setTenant] = useState<Tenant | null>(null)

  useEffect(() => {
    if (!tenantId) return
    getTenant(tenantId)
      .then(setTenant)
      .catch(() => setTenant(null))
  }, [tenantId])

  async function print(orderId: string, posPointName: string | null = null) {
    if (!tenantId) return
    setPrinting(true)
    setError(null)
    try {
      const data = await loadPosReceiptData(tenantId, orderId, posPointName)
      if (!data) throw new Error(t('pos.receipt.errors.load'))
      if (data.tenant.pos_receipt_use_webusb) {
        const widthMm = data.tenant.pos_receipt_paper_width === '58mm' ? 58 : 80
        await printRaw(buildChargedReceiptEscPos(data, t, language, widthMm))
        return
      }
      setPortal(
        <ReceiptPrintPortal paperWidth={data.tenant.pos_receipt_paper_width} onDone={() => setPortal(null)}>
          <PosReceiptTicket data={data} />
        </ReceiptPrintPortal>,
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : t('pos.receipt.errors.load'))
    } finally {
      setPrinting(false)
    }
  }

  /** Vista previa de "lo que tengo cargado" -- sin pedido, sin pago, nunca
   * factura. `tenant` ya debería estar resuelto (se carga al montar el
   * hook); si por algún motivo todavía no llegó, se pide una vez más acá
   * mismo en vez de dejar el botón sin efecto. */
  async function printPending(items: PosPendingReceiptItem[], totals: OrderTotalsBreakdown, opts: { posPointName?: string | null; customerName?: string | null } = {}) {
    if (!tenantId) return
    setError(null)
    const resolvedTenant = tenant ?? (await getTenant(tenantId).catch(() => null))
    if (!resolvedTenant) {
      setError(t('pos.receipt.errors.load'))
      return
    }
    const pendingData = { tenant: resolvedTenant, items, totals, posPointName: opts.posPointName ?? null, customerName: opts.customerName ?? null }
    if (resolvedTenant.pos_receipt_use_webusb) {
      const widthMm = resolvedTenant.pos_receipt_paper_width === '58mm' ? 58 : 80
      try {
        await printRaw(buildPendingReceiptEscPos(pendingData, t, language, widthMm))
      } catch (err) {
        setError(err instanceof Error ? err.message : t('pos.receipt.errors.load'))
      }
      return
    }
    setPortal(
      <ReceiptPrintPortal paperWidth={resolvedTenant.pos_receipt_paper_width} onDone={() => setPortal(null)}>
        <PosPendingReceiptTicket data={pendingData} />
      </ReceiptPrintPortal>,
    )
  }

  return { print, printPending, printing, error, portal, autoPrintEnabled: tenant?.pos_auto_print ?? false }
}
