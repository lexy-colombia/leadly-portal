import { supabase } from '../supabaseClient'
import type { SalesInvoice } from '../../types/domain'

/** La factura DIAN de un pedido vive DENTRO de ese pedido (card en
 * OrderDetail.tsx), no en una lista propia -- feedback explícito del usuario
 * 2026-09-03: no tiene sentido duplicar comprador/vendedor/ítems en una
 * segunda pantalla cuando el pedido ya los muestra. Por eso esta API se
 * consulta por order_id, no hay un `listSalesInvoices` por tenant.
 *
 * Devuelve SOLO el intento vigente (el de attempt_number más alto), no el
 * historial: un pedido puede acumular varios intentos cuando la DIAN rechaza
 * y se reintenta, pero al usuario del portal eso no le sirve de nada
 * -- feedback explícito 2026-09-03: "o la factura fue aceptada o no lo fue,
 * no es más lo que necesitamos aquí". Los intentos anteriores se siguen
 * guardando en la base (son registros fiscales, ver
 * 20260903110000_sales_invoices.sql) y de ahí sale el attempt_number del
 * próximo reintento; simplemente no se muestran. */
export async function getLatestSalesInvoiceForOrder(orderId: string): Promise<SalesInvoice | null> {
  const { data, error } = await supabase
    .from('sales_invoices')
    .select('*')
    .eq('order_id', orderId)
    .order('attempt_number', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return data
}

export interface SendSalesInvoiceResult {
  status: 'sent' | 'error'
  httpStatus: number
  cufe: string | null
  dianTrackingId: string | null
  faultReason: string | null
  invoicePrefix: string
  invoiceNumber: number
}

/** Firma y envía la factura a la DIAN (dian-submit, acción `send_invoice`) --
 * solo tenant_admin/superadmin (la Edge Function lo vuelve a validar del
 * lado del servidor, esto no es el único candado). Actualiza la fila de
 * sales_invoices server-side antes de responder -- refrescar la factura
 * después de llamar esto siempre refleja el resultado real.
 *
 * Un rechazo de la DIAN (ej. certificado vencido) NO es un error HTTP --
 * la función responde 200 con `status: 'error'` y `faultReason`, porque es
 * un resultado de negocio esperado (queda registrado en la factura), no una
 * falla de la llamada. Solo se lanza excepción para fallas de la llamada
 * misma (sin sesión, sin permiso, factura inexistente) -- mismo patrón de
 * extracción de mensaje que createWompiPaymentLink en orderPayments.ts. */
export async function sendSalesInvoiceToDian(invoiceId: string): Promise<SendSalesInvoiceResult> {
  return invokeDianSubmit('send_invoice', invoiceId)
}

/** Reintenta una factura que la DIAN rechazó (o que falló al enviarse). No
 * reescribe el intento fallido: el servidor crea una fila NUEVA de
 * sales_invoices con attempt_number+1 y envía ésa, porque una factura
 * rechazada es un registro de auditoría que no se puede editar (ver
 * 20260903110000_sales_invoices.sql). Los snapshots del intento nuevo se
 * rearman con los datos actuales del cliente/tenant -- si el rechazo fue por
 * un dato mal cargado, corregirlo y reintentar es justamente el flujo.
 *
 * Por eso hay que refrescar el listado después de llamarla: aparece un
 * intento más, no cambia el que ya estaba. */
export async function retrySalesInvoiceToDian(invoiceId: string): Promise<SendSalesInvoiceResult> {
  return invokeDianSubmit('retry_invoice', invoiceId)
}

async function invokeDianSubmit(action: 'send_invoice' | 'retry_invoice', invoiceId: string): Promise<SendSalesInvoiceResult> {
  const { data, error } = await supabase.functions.invoke<SendSalesInvoiceResult & { error?: string }>('dian-submit', {
    body: { action, invoice_id: invoiceId },
  })
  if (error) {
    const context = (error as { context?: Response }).context
    if (context && typeof context.json === 'function') {
      let specificMessage: string | undefined
      try {
        const body = await context.json()
        specificMessage = body?.error
      } catch {
        /* fall through to generic error */
      }
      if (specificMessage) throw new Error(specificMessage)
    }
    throw error
  }
  return data as SendSalesInvoiceResult
}

interface InvoicePdfResponse {
  pdf_base64: string
  filename: string
  error?: string
}

/** Representación gráfica (PDF) del pedido. Se pide por ORDER_ID, no por
 * factura, por dos motivos (pedido explícito del usuario 2026-09-04):
 *
 * 1. Un tenant sin facturación electrónica DIAN nunca genera una fila de
 *    sales_invoices, así que no habría ningún id que pasar -- y ese tenant
 *    igual necesita imprimir el documento. En ese caso el servidor emite una
 *    REMISIÓN (mismo diseño, numerada REM-<pedido>, sin resolución, CUFE ni
 *    QR) en vez de una factura.
 * 2. El PDF refleja el pedido tal como está AHORA, no el snapshot congelado
 *    de la factura: "debe ser siempre lo que tengo en mi pantalla".
 *
 * Cualquier miembro del tenant puede descargarlo (no es una acción con
 * efecto fiscal, solo lectura/render), a diferencia de
 * sendSalesInvoiceToDian que es admin-only. Se genera on-demand en el
 * servidor en cada llamada, ver sales-invoice-pdf/index.ts. */
export async function getSalesOrderPdf(orderId: string): Promise<{ pdfBase64: string; filename: string }> {
  const { data, error } = await supabase.functions.invoke<InvoicePdfResponse>('sales-invoice-pdf', {
    body: { order_id: orderId },
  })
  if (error) {
    const context = (error as { context?: Response }).context
    if (context && typeof context.json === 'function') {
      let specificMessage: string | undefined
      try {
        const body = await context.json()
        specificMessage = body?.error
      } catch {
        /* fall through to generic error */
      }
      if (specificMessage) throw new Error(specificMessage)
    }
    throw error
  }
  return { pdfBase64: data!.pdf_base64, filename: data!.filename }
}
