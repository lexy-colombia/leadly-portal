import QRCode from 'qrcode'
import { getTenant } from './tenants'
import { getOrder, getOrderTotalsBreakdown, listOrderItems, type OrderDetail, type OrderTotalsBreakdown } from './orders'
import { listPaymentsForOrder } from './orderPayments'
import { getLatestSalesInvoiceForOrder } from './salesInvoices'
import { getTenantDianProfile } from './tenantDianProfile'
import { getIntegrationCredential } from './integrations'
import type { SalesInvoiceStatus, SalesOrderItem, SalesOrderPayment, Tenant } from '../../types/domain'

/** Mismo criterio que sales-invoice-pdf/index.ts (la Edge Function que arma
 * el PDF descargable), con un candado extra que el PDF no necesita (ver
 * `hasFiscalSetup` más abajo):
 * - `isRemision`: true salvo que el tenant tenga la fila de sales_invoices
 *   (el trigger de confirmación la crea si dian_directo está activo) Y
 *   además ya haya cargado su resolución real (tenant_dian_profile.is_configured).
 *   Sin las dos cosas es un TICKET nomás -- sin resolución, sin CUFE, sin QR.
 * - `isValidated = status sent|accepted`: recién ahí el CUFE es un dato real
 *   que la DIAN aceptó -- antes de eso existe (se calcula ANTES de enviar)
 *   pero mostrarlo sería aparentar un documento verificable que no lo es.
 */
export interface PosReceiptFiscalData {
  isRemision: boolean
  /** "FES-123" (factura ya numerada), "REM-42" (remisión, numerada con el
   * pedido) -- mismo invoiceDisplayLabel que usa el PDF. */
  documentLabel: string
  status: SalesInvoiceStatus | null
  statusDetail: string | null
  isValidated: boolean
  cufe: string | null
  qrVerificationUrl: string | null
  /** PNG en data: URL, ya generado -- se resuelve acá (síncrono, sin red,
   * solo canvas) para que esté listo ANTES de que el ticket se monte, igual
   * que el resto de los datos. A diferencia del logo del tenant (una imagen
   * remota real, que si tarda no debe trabar el cobro), este nunca depende
   * de la red. */
  qrDataUrl: string | null
  resolution: {
    number: string | null
    prefix: string | null
    range_from: number | null
    range_to: number | null
    valid_from: string | null
    valid_until: string | null
  } | null
}

export interface PosReceiptData {
  tenant: Tenant
  order: OrderDetail
  items: SalesOrderItem[]
  payments: SalesOrderPayment[]
  totals: OrderTotalsBreakdown
  fiscal: PosReceiptFiscalData
  /** Nombre del punto de venta (mesa/caja) -- el llamador ya lo tiene
   * cargado en memoria (PosOpenTabs/PosTabAccount, ver `points`), así que
   * se resuelve ahí en vez de sumar otro round-trip acá solo para leer un
   * nombre. `null` cuando el pedido no vino de un punto (venta rápida, sin
   * cuentas abiertas). */
  posPointName: string | null
}

async function loadFiscalData(tenantId: string, orderNumber: number, orderId: string): Promise<PosReceiptFiscalData> {
  const [invoice, dianProfile, credential] = await Promise.all([
    getLatestSalesInvoiceForOrder(orderId),
    getTenantDianProfile(tenantId),
    getIntegrationCredential('dian_directo', tenantId),
  ])

  // No alcanza con que exista una fila de sales_invoices -- el trigger que
  // la crea (apply_sales_order_confirmed_effects) solo mira si la
  // credencial dian_directo está activa, sin exigir que el tenant ya haya
  // cargado su resolución real. Un tenant que activó la integración pero
  // todavía no completó el formulario (ver DianDirectoCredentialDrawer,
  // is_configured = resolución completa) no tiene ningún dato fiscal real
  // que mostrar -- imprimir "Factura electrónica de venta" ahí sería
  // aparentar un documento que no existe. Hallazgo real del usuario
  // 2026-09-04 contra TecnoNova Colombia (DIAN activada, resolución vacía).
  const hasFiscalSetup = !!(invoice && dianProfile?.is_configured)
  const isRemision = !hasFiscalSetup
  const isValidated = invoice?.status === 'sent' || invoice?.status === 'accepted'
  const resolution =
    isRemision || !dianProfile
      ? null
      : {
          number: dianProfile.resolution_number,
          prefix: dianProfile.resolution_prefix,
          range_from: dianProfile.resolution_range_from,
          range_to: dianProfile.resolution_range_to,
          valid_from: dianProfile.resolution_valid_from,
          valid_until: dianProfile.resolution_valid_until,
        }

  const displayPrefix = isRemision ? 'REM' : (invoice?.invoice_prefix ?? resolution?.prefix ?? null)
  const displayNumber = isRemision ? orderNumber : (invoice?.invoice_number ?? orderNumber)
  const documentLabel = displayPrefix ? `${displayPrefix}-${displayNumber}` : String(displayNumber)

  const cufe = !isRemision && isValidated ? (invoice?.cufe ?? null) : null
  let qrVerificationUrl: string | null = null
  let qrDataUrl: string | null = null
  if (cufe) {
    const qrHost = credential?.mode === 'production' ? 'catalogo-vpfe.dian.gov.co' : 'catalogo-vpfe-hab.dian.gov.co'
    qrVerificationUrl = `https://${qrHost}/document/searchqr?documentkey=${cufe}`
    qrDataUrl = await QRCode.toDataURL(qrVerificationUrl, { margin: 1, width: 240 }).catch(() => null)
  }

  return {
    isRemision,
    documentLabel,
    status: invoice?.status ?? null,
    statusDetail: invoice?.status_detail ?? null,
    isValidated,
    cufe,
    qrVerificationUrl,
    qrDataUrl,
    resolution,
  }
}

/** Todo lo que necesita el ticket, en un solo lugar -- lo mismo que ya
 * carga OrderDetail.tsx en piezas sueltas, reunido acá para que imprimir
 * un recibo sea una sola llamada desde cualquier pantalla del POS. Nunca
 * calcula nada de negocio: el desglose de impuestos sale de
 * getOrderTotalsBreakdown (columnas ya persistidas por el servidor en
 * sales_order_items) y los datos fiscales salen de sales_invoices/
 * tenant_dian_profile, igual que el resto de la app. */
export async function loadPosReceiptData(tenantId: string, orderId: string, posPointName: string | null = null): Promise<PosReceiptData | null> {
  const order = await getOrder(orderId)
  if (!order) return null

  const [tenant, items, payments, totals, fiscal] = await Promise.all([
    getTenant(tenantId),
    listOrderItems(orderId),
    listPaymentsForOrder(orderId),
    getOrderTotalsBreakdown(order),
    loadFiscalData(tenantId, order.number, orderId),
  ])
  if (!tenant) return null

  return { tenant, order, items, payments, totals, fiscal, posPointName }
}
