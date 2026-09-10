import { supabase } from '../supabaseClient'
import type { CreditNoteReasonCode, SalesCreditNote, SalesInvoice } from '../../types/domain'

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

/** Todos los intentos de factura de un pedido, más reciente primero --
 * a diferencia de getLatestSalesInvoiceForOrder, esta SÍ importa el
 * historial completo: pedido explícito del usuario 2026-09-09, "debería
 * salirme el historial de documentos emitidos" -- una factura ya
 * sent/accepted no se anula ni desaparece cuando se corrige con una nota
 * crédito y se emite una nueva (ver
 * 20260909220000_sales_invoices_no_voided_reissue_after_credit.sql), así
 * que el pedido puede acumular más de un documento fiscal real en su
 * historia. Los intentos rejected/error también vienen incluidos (quedan
 * ocultos en el render, ver OrderDetail.tsx) -- no se filtran acá para no
 * duplicar ese criterio en dos lugares. */
export async function listSalesInvoicesForOrder(orderId: string): Promise<SalesInvoice[]> {
  const { data, error } = await supabase
    .from('sales_invoices')
    .select('*')
    .eq('order_id', orderId)
    .order('attempt_number', { ascending: false })
  if (error) throw error
  return data
}

export interface SendSalesInvoiceResult {
  /** `accepted`/`rejected`: veredicto REAL ya confirmado por la DIAN --
   * pedido explícito del usuario 2026-09-09, el propio envío consulta el
   * estado antes de responder, ya no hace falta un paso aparte de
   * "Verificar estado" para saber si una factura se aceptó o rechazó.
   * `sent`: se mandó pero la DIAN no terminó de procesarla dentro del
   * tiempo de espera -- "Verificar estado" sigue disponible como respaldo
   * para ese caso. `error`: falló el envío en sí, nunca llegó a la DIAN. */
  status: 'accepted' | 'rejected' | 'sent' | 'error'
  httpStatus: number
  cufe: string | null
  dianTrackingId: string | null
  faultReason: string | null
  /** Motivo real de rechazo (reglas FAxx) cuando `status === 'rejected'`. */
  rejectionDetail: string | null
  invoicePrefix: string
  invoiceNumber: number
}

/** Firma y envía la factura a la DIAN (dian-submit, acción `send_invoice`) --
 * solo tenant_admin/superadmin (la Edge Function lo vuelve a validar del
 * lado del servidor, esto no es el único candado). Actualiza la fila de
 * sales_invoices server-side antes de responder -- refrescar la factura
 * después de llamar esto siempre refleja el resultado real.
 *
 * Un rechazo de la DIAN (ej. certificado vencido, o una regla de validación
 * real) NO es un error HTTP -- la función responde 200 con
 * `status: 'error'`/`'rejected'` y el detalle correspondiente, porque es un
 * resultado de negocio esperado (queda registrado en la factura), no una
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

/** Envía a la DIAN, en el momento de cobrar, la factura que el trigger de
 * confirmación ya reservó para un pedido del POS -- acción `send_pos_invoice`
 * de dian-submit, deliberadamente más angosta que sendSalesInvoiceToDian
 * (esa es admin-only para reenviar/reintentar cualquier factura; esta la
 * puede disparar cualquiera con permiso `pos.checkout`, solo sobre pedidos
 * `sales_channel='pos'` ya pagos del todo). Nunca crea una factura -- si el
 * pedido no tiene ninguna reservada, o el comprador elegido no tiene datos
 * fiscales, el servidor responde con un error claro. */
export async function sendPosInvoiceForOrder(orderId: string): Promise<SendSalesInvoiceResult> {
  const { data, error } = await supabase.functions.invoke<SendSalesInvoiceResult & { error?: string }>('dian-submit', {
    body: { action: 'send_pos_invoice', order_id: orderId },
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

/** Historial completo de notas crédito de una factura (no solo la vigente,
 * a diferencia de getLatestSalesInvoiceForOrder -- acá SÍ importa ver todos
 * los intentos: cada nota crédito exitosa es un documento fiscal propio, no
 * un "intento" de algo único). */
export async function listCreditNotesForInvoice(invoiceId: string): Promise<SalesCreditNote[]> {
  const { data, error } = await supabase
    .from('sales_credit_notes')
    .select('*')
    .eq('invoice_id', invoiceId)
    .order('created_at', { ascending: false })
  if (error) throw error
  return data
}

export interface CreateCreditNoteResult {
  /** Mismo criterio que SendSalesInvoiceResult (ver ese comentario). */
  status: 'accepted' | 'rejected' | 'sent' | 'error'
  httpStatus: number
  cude: string | null
  dianTrackingId: string | null
  faultReason: string | null
  rejectionDetail: string | null
  creditNotePrefix: string
  creditNoteNumber: number
}

/** Crea y envía de una sola vez una nota crédito sobre una factura ya
 * aceptada por la DIAN (dian-submit, acción `create_credit_note`) -- solo
 * tenant_admin/superadmin, la Edge Function lo vuelve a validar. Un rechazo
 * de la DIAN (o un error de negocio, ej. saldo insuficiente) NO es
 * necesariamente una excepción: si la creación misma falla (monto inválido,
 * factura no aceptada) se lanza; si la DIAN rechaza el envío ya creado, la
 * función responde 200 con `status: 'error'` -- mismo criterio que
 * sendSalesInvoiceToDian. */
export async function createAndSendCreditNote(
  invoiceId: string,
  input: { amount: number; reasonCode: CreditNoteReasonCode; reasonDescription: string },
): Promise<CreateCreditNoteResult> {
  const { data, error } = await supabase.functions.invoke<CreateCreditNoteResult & { error?: string }>('dian-submit', {
    body: {
      action: 'create_credit_note',
      invoice_id: invoiceId,
      amount: input.amount,
      reason_code: input.reasonCode,
      reason_description: input.reasonDescription,
    },
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
  return data as CreateCreditNoteResult
}

/** Reintenta una nota crédito que quedó en 'error' o 'rejected' -- misma
 * fila, mismos datos ya validados al crearla (dian-submit, acción
 * `retry_credit_note`). A diferencia de retrySalesInvoiceToDian, esto NO
 * crea una fila nueva: una nota crédito no tiene el mismo problema de
 * numeración encadenada que una factura (nunca llegó a consumir un
 * consecutivo si falló antes de que la DIAN la aceptara). */
export async function retryCreditNote(creditNoteId: string): Promise<CreateCreditNoteResult> {
  const { data, error } = await supabase.functions.invoke<CreateCreditNoteResult & { error?: string }>('dian-submit', {
    body: { action: 'retry_credit_note', credit_note_id: creditNoteId },
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
  return data as CreateCreditNoteResult
}

export interface DianTrackStatus {
  isValid: boolean | null
  statusCode: string | null
  statusDescription: string | null
  statusMessage: string | null
  errorMessages: string[]
  xmlDocumentKey: string | null
  xmlFileName: string | null
}

export interface CheckDianStatusResult {
  httpStatus: number
  responseBody: string
  faultReason: string | null
  statuses: DianTrackStatus[]
}

/** Botón "Verificar estado" -- SendTestSetAsync es asíncrona: el acuse
 * inicial (`dian_tracking_id`) no es la validación final. Pedido explícito
 * del usuario 2026-09-09 ("en el portal de la DIAN no salen esas facturas
 * por ningún lado, en habilitación deberían salir"): antes de esto,
 * Leadly marcaba la factura como 'sent' apenas recibía el acuse y nunca
 * volvía a preguntarle a la DIAN qué pasó después. Esto consulta
 * GetStatusZip(trackId) de verdad (dian-submit, acción
 * `check_invoice_status`) y, si la DIAN ya dio un veredicto, actualiza la
 * fila server-side a 'accepted'/'rejected' antes de responder -- refrescar
 * la factura después de llamar esto refleja el resultado real. */
export async function checkInvoiceStatus(invoiceId: string): Promise<CheckDianStatusResult> {
  const { data, error } = await supabase.functions.invoke<CheckDianStatusResult & { error?: string }>('dian-submit', {
    body: { action: 'check_invoice_status', invoice_id: invoiceId },
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
  return data as CheckDianStatusResult
}

/** Misma idea que checkInvoiceStatus, para una nota crédito. */
export async function checkCreditNoteStatus(creditNoteId: string): Promise<CheckDianStatusResult> {
  const { data, error } = await supabase.functions.invoke<CheckDianStatusResult & { error?: string }>('dian-submit', {
    body: { action: 'check_credit_note_status', credit_note_id: creditNoteId },
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
  return data as CheckDianStatusResult
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

/** Representación gráfica (PDF) de una nota crédito ya enviada/aceptada --
 * pedido explícito del usuario ("y como descargo o visualizo la nota
 * crédito?", 2026-09-09). A diferencia de getSalesOrderPdf, sale del
 * snapshot propio de la nota (no hay nada "en pantalla" que pueda haber
 * cambiado después: una nota crédito no se vuelve a editar una vez
 * creada), ver sales-credit-note-pdf/index.ts. */
export async function getCreditNotePdf(creditNoteId: string): Promise<{ pdfBase64: string; filename: string }> {
  const { data, error } = await supabase.functions.invoke<InvoicePdfResponse>('sales-credit-note-pdf', {
    body: { credit_note_id: creditNoteId },
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
