import QRCode from 'qrcode'
import { getTenant } from './tenants'
import { getOrder, getOrderTotalsBreakdown, listOrderItems, type OrderDetail, type OrderTotalsBreakdown } from './orders'
import { listPaymentsForOrder } from './orderPayments'
import { getLatestSalesInvoiceForOrder } from './salesInvoices'
import { getTenantDianProfile } from './tenantDianProfile'
import { getIntegrationCredential } from './integrations'
import type { SalesInvoiceStatus, SalesOrderItem, SalesOrderPayment, Tenant } from '../../types/domain'

/** Mismo criterio que sales-invoice-pdf/index.ts (la Edge Function que arma
 * el PDF descargable) -- las dos calculan `isRemision` de la misma forma
 * exacta, ver loadFiscalData más abajo:
 * - `isRemision`: false ÚNICAMENTE cuando esta factura puntual ya fue
 *   aceptada/enviada por la DIAN (`status` sent|accepted) Y tiene CUFE real
 *   Y tiene `invoice_number` real -- los tres se escriben juntos, y solo al
 *   confirmar la DIAN la recepción (ver sendInvoiceToDian.ts). Cualquier
 *   otro estado (sin fila de sales_invoices, pending, generating, sending,
 *   rejected, error, blocked_missing_buyer_data) es remisión sin excepción:
 *   sin resolución, sin número de factura, sin CUFE, sin QR. No alcanza con
 *   que el tenant tenga la integración activa y la resolución cargada --
 *   eso solo dice que PODRÍA facturar, no que esta venta puntual ya está
 *   facturada.
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

  // CORREGIDO 2026-09-05 -- error grave reportado por el usuario: antes
  // alcanzaba con que existiera una fila de sales_invoices Y el tenant
  // tuviera su resolución cargada (`dianProfile?.is_configured`) para
  // mostrar el título "Factura electrónica de venta" + la resolución DIAN +
  // un número de documento -- sin exigir que la DIAN hubiera aceptado nada
  // todavía. Una factura en 'pending'/'generating'/'sending'/'rejected'/
  // 'error' salía con pinta de documento fiscal real (resolución + número)
  // pero sin CUFE ni QR -- eso es aparentar un comprobante que legalmente
  // no existe. Peor aún: sin CUFE/invoice_number reales, el número
  // mostrado caía al número interno del pedido (`?? orderNumber`), que NO
  // es el consecutivo de la resolución DIAN -- una numeración inventada
  // bajo el rótulo de "factura electrónica".
  //
  // Ahora `isRemision` exige la prueba concreta de que ESTA factura
  // puntual ya fue validada: `sent`/`accepted` Y tiene CUFE real Y tiene un
  // `invoice_number` real (asignado únicamente por sendInvoiceToDian.ts
  // cuando la DIAN confirma la recepción, nunca antes). Cualquier otro
  // estado -- incluido "el tenant tiene DIAN activada pero este pedido
  // todavía no se envió o se envió y fue rechazado" -- es remisión sin
  // excepción: sin resolución, sin CUFE, sin QR, numerada con el pedido
  // (REM-<pedido>), igual que un tenant sin facturación electrónica.
  const isValidated = invoice?.status === 'sent' || invoice?.status === 'accepted'
  const isRemision = !(invoice && isValidated && !!invoice.cufe && invoice.invoice_number != null)
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

  // Con isRemision ya corregido, el lado `else` de estos dos ternarios solo
  // se alcanza cuando invoice/cufe/invoice_number son, por construcción,
  // reales -- nunca inventa un número a partir del pedido.
  const displayPrefix = isRemision ? 'REM' : (invoice?.invoice_prefix ?? null)
  const displayNumber = isRemision ? orderNumber : (invoice?.invoice_number ?? null)
  const documentLabel = displayPrefix ? `${displayPrefix}-${displayNumber}` : String(displayNumber)

  const cufe = isRemision ? null : (invoice?.cufe ?? null)
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
