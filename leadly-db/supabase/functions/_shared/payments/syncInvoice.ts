// Reconciliacion de una factura de plataforma contra el servicio de pagos (no contra
// Wompi directo). El servicio ya verifico la transaccion con Wompi y dejo el link en
// 'paid'; si el aviso firmado a payments-internal no llego, esto aplica el mismo efecto
// con la MISMA funcion SQL del consumidor (apply_wompi_invoice_payment): nunca se
// duplica la logica de PAID.
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { logEvent } from "../payments-service/errors.ts";
import { getInternalPaymentLink } from "../payments-service/internalLinks.ts";
import type { InternalLinkOptions } from "../payments-service/internalLinks.ts";

export interface InvoiceToSync {
  id: string;
  payer_tenant_id: string | null;
  payments_link_id: string;
  /** Comprobante anulado: no se reconcilia (el SQL lo rechazaria como invoice_closed). */
  deleted_at?: string | null;
}

/** true solo si ESTA llamada acredito la factura (applied). 'duplicate' = ya estaba aplicada. */
export async function syncInvoiceFromService(
  adminClient: SupabaseClient,
  invoice: InvoiceToSync,
  opts?: InternalLinkOptions,
): Promise<{ synced: boolean; result: string }> {
  if (invoice.deleted_at) return { synced: false, result: "invoice_deleted" };
  const link = await getInternalPaymentLink(invoice.payments_link_id, opts);
  if (!link) return { synced: false, result: "link_not_found" };
  if (link.status !== "paid") return { synced: false, result: `link_${String(link.status)}` };
  const txId = typeof link.paid_transaction_id === "string" ? link.paid_transaction_id : null;
  const cents = link.amount_in_cents;
  if (!txId || typeof cents !== "number" || !Number.isSafeInteger(cents) || typeof link.currency !== "string" || !invoice.payer_tenant_id) {
    return { synced: false, result: "link_incomplete" };
  }
  // tenant = el pagador leido de la FILA de la factura (no del link): el SQL lo compara con la factura.
  const { data, error } = await adminClient.rpc("apply_wompi_invoice_payment", {
    p_invoice_id: invoice.id,
    p_tenant_id: invoice.payer_tenant_id,
    p_transaction_id: txId,
    p_amount_cents: cents,
    p_link_amount_cents: cents,
    p_currency: link.currency,
    p_payment: {},
  });
  if (error) throw new Error(error.message);
  const result = String((data as { result?: unknown } | null)?.result ?? "unexpected");
  if (result === "not_applicable" || result === "conflict") {
    // El link esta pagado pero la factura no se pudo acreditar: no puede quedar en silencio.
    logEvent({ level: "critical", event: "invoice_sync_not_credited", invoice_id: invoice.id, link_id: invoice.payments_link_id, result, reason: (data as { reason?: unknown } | null)?.reason ?? null });
  }
  return { synced: result === "applied", result };
}
