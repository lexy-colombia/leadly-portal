import { useEffect, useState, type ReactNode } from 'react'
import { loadPosReceiptData } from './api/posReceipt'
import { getTenant } from './api/tenants'
import { ReceiptPrintPortal } from '../components/pos/ReceiptPrintPortal'
import { useLanguage } from '../contexts/LanguageContext'

/** Único punto de entrada para imprimir un ticket POS desde cualquier
 * pantalla (venta rápida, cuenta abierta, listado, detalle de la orden) --
 * pedido explícito del usuario: un hook, no un componente nuevo por
 * pantalla. `print(orderId)` carga todo lo que hace falta (tenant, pedido,
 * ítems, pagos, desglose de impuestos -- ver loadPosReceiptData) y renderiza
 * `portal` en el árbol, que dispara el diálogo de impresión del sistema
 * solo. El caller monta `portal` una vez en su JSX y listo -- no necesita
 * saber nada de cómo se arma el ticket. */
export function usePosReceiptPrinter(tenantId: string | null | undefined) {
  const { t } = useLanguage()
  const [printing, setPrinting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [portal, setPortal] = useState<ReactNode>(null)
  // Se resuelve una vez, aparte de print(), para que la pantalla sepa SI
  // debe llamar a print() automáticamente apenas se cobra -- sin esto,
  // decidir "auto-imprimir o no" habría significado cargar el tenant
  // completo en cada pantalla del POS solo por este flag.
  const [autoPrintEnabled, setAutoPrintEnabled] = useState(false)

  useEffect(() => {
    if (!tenantId) return
    getTenant(tenantId)
      .then((tenant) => setAutoPrintEnabled(tenant?.pos_auto_print ?? false))
      .catch(() => setAutoPrintEnabled(false))
  }, [tenantId])

  async function print(orderId: string, posPointName: string | null = null) {
    if (!tenantId) return
    setPrinting(true)
    setError(null)
    try {
      const data = await loadPosReceiptData(tenantId, orderId, posPointName)
      if (!data) throw new Error(t('pos.receipt.errors.load'))
      setPortal(
        <ReceiptPrintPortal
          data={data}
          paperWidth={data.tenant.pos_receipt_paper_width}
          onDone={() => setPortal(null)}
        />,
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : t('pos.receipt.errors.load'))
    } finally {
      setPrinting(false)
    }
  }

  return { print, printing, error, portal, autoPrintEnabled }
}
