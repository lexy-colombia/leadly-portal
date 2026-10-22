// Checkout de una factura de plataforma (payment_invoices) por el servicio de pagos.
// Extraido de create-payment-checkout para poder probarlo con fakes.
//
// Vinculo link <-> factura (D5): external_reference "invoice:<id>" y metadata
// {kind:'invoice', tenant_id:<payer_tenant_id de la FILA>, invoice_id}, SIEMPRE armada
// desde la fila leida por el llamador. payments-internal acredita la factura
// (apply_wompi_invoice_payment) cuando Wompi confirma. Lexy es la vendedora: el IVA 19%
// que corresponde a la propia fila (tax_cents / tax_rate) se manda explicito; sin impuesto no se manda `taxes`.
// El documento es un "comprobante de cobro", NO una factura electronica.
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { createInternalPaymentLink, getInternalPaymentLink } from "../payments-service/internalLinks.ts";
import type { InternalLinkOptions } from "../payments-service/internalLinks.ts";
import { logEvent } from "../payments-service/errors.ts";

const MAX_NAME = 150;

export interface InvoiceForCheckout {
  id: string;
  merchant_tenant_id: string | null;
  payer_tenant_id: string | null;
  provider_key: string;
  amount_cents: number;
  currency: string;
  description: string | null;
  invoice_number: string | null;
  payments_link_id: string | null;
  /** Impuesto ya guardado en la fila (incluido en amount_cents). Opcionales: filas/fakes viejos sin ellos = sin impuesto. */
  tax_rate?: number | null;
  tax_cents?: number | null;
  /** Periodo que cubre (yyyy-mm-dd); null en historicos y comprobantes manuales. */
  period_start?: string | null;
  period_end?: string | null;
  /** Comprobante anulado (soft-delete, p. ej. al cancelar la suscripcion): nunca se cobra. */
  deleted_at?: string | null;
}

const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

/** "2026-10-10" -> "10 oct 2026" (sin Date: sin corrimientos de huso). null si no es una fecha yyyy-mm-dd valida. */
export function formatPeriodDay(iso: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ""));
  if (!m) return null;
  const mon = Number(m[2]);
  if (mon < 1 || mon > 12) return null;
  return `${m[3]} ${MONTHS[mon - 1]} ${m[1]}`;
}

/** "Comprobante de cobro <numero> · <plan> (<dd mmm aaaa – dd mmm aaaa>)"; sin periodo, sin parentesis; sin plan, sin " · ".
 * Con `maxLen`, si no cabe se recorta el NOMBRE DEL PLAN (con "…"): numero y periodo se conservan. */
export function buildInvoiceLabel(
  invoice: Pick<InvoiceForCheckout, "id" | "invoice_number" | "description" | "period_start" | "period_end">,
  maxLen?: number,
): string {
  const head = `Comprobante de cobro ${invoice.invoice_number ?? invoice.id}`;
  const from = formatPeriodDay(invoice.period_start);
  const to = formatPeriodDay(invoice.period_end);
  const tail = from && to ? ` (${from} – ${to})` : "";
  let plan = invoice.description?.trim() ?? "";
  if (maxLen !== undefined && plan) {
    const room = maxLen - head.length - tail.length - 3; // 3 = " · "
    if (plan.length > room) plan = room >= 2 ? plan.slice(0, room - 1).trimEnd() + "…" : "";
  }
  return head + (plan ? ` · ${plan}` : "") + tail;
}

export type InvoiceCheckoutResult = { ok: true; checkoutUrl: string } | { ok: false; status: number; error: string };

export async function ensureInvoiceCheckout(
  adminClient: SupabaseClient,
  invoice: InvoiceForCheckout,
  createdBy: string | null,
  redirectUrl: string | undefined,
  opts?: InternalLinkOptions,
): Promise<InvoiceCheckoutResult> {
  if (invoice.deleted_at) return { ok: false, status: 409, error: "Este comprobante fue anulado." };
  if (invoice.provider_key !== "wompi") return { ok: false, status: 400, error: "Este comprobante no se cobra con Wompi." };
  if (!invoice.payer_tenant_id) return { ok: false, status: 400, error: "El comprobante no tiene un tenant pagador." };

  // Link ya creado por el servicio: se reutiliza mientras siga pendiente.
  if (invoice.payments_link_id) {
    const existing = await getInternalPaymentLink(invoice.payments_link_id, opts);
    if (existing) {
      const st = String(existing.status);
      // Un link pendiente solo se reutiliza si cobra EXACTAMENTE lo que la factura cobra hoy:
      // si el monto/moneda cambio, pagarlo daria not_applicable/amount_mismatch (cobro sin acreditar).
      const sameTerms = Number(existing.amount_in_cents) === Number(invoice.amount_cents) && existing.currency === invoice.currency;
      if (st === "pending" && sameTerms && typeof existing.checkout_url === "string" && existing.checkout_url) {
        return { ok: true, checkoutUrl: existing.checkout_url };
      }
      if (st === "pending" && !sameTerms) {
        logEvent({ level: "warn", event: "invoice_link_stale_terms", invoice_id: invoice.id, link_id: invoice.payments_link_id });
      }
      if (st === "paid") {
        // Link pagado y factura aun pendiente: o el aviso esta en camino, o apply_wompi_invoice_payment
        // devolvio not_applicable/conflict (p. ej. amount_mismatch). Se distingue por los terminos y queda en el log.
        const sameTermsPaid = Number(existing.amount_in_cents) === Number(invoice.amount_cents) && existing.currency === invoice.currency;
        logEvent({
          level: "critical", event: "invoice_link_paid_but_invoice_pending", invoice_id: invoice.id, link_id: invoice.payments_link_id,
          terms_match: sameTermsPaid, action: "revisar payments-internal / sincronizar; si no es amount_mismatch, es un aviso pendiente",
        });
        return {
          ok: false, status: 409,
          error: sameTermsPaid
            ? "El pago de este comprobante ya fue recibido y se está confirmando. Si persiste, usa «Sincronizar con el proveedor» o contacta a soporte."
            : "Se recibió un pago por un monto distinto al del comprobante actual. Contacta a soporte para conciliarlo.",
        };
      }
      if (st === "creating") return { ok: false, status: 409, error: "Ya se está generando el link de pago de este comprobante. Intenta de nuevo en unos segundos." };
      // expired / cancelled / voided / error: se crea uno nuevo abajo.
    }
  }

  const amountCents = Number(invoice.amount_cents);
  const label = buildInvoiceLabel(invoice);
  const nameLabel = buildInvoiceLabel(invoice, MAX_NAME);
  // Impuesto = el de la propia fila (ya incluido en amount_cents). Sin tasa o sin monto -> sin `taxes`.
  // Un valor imposible (no entero, negativo o mayor al monto) NO se manda: el servicio lo rechazaria o,
  // peor, el comprador veria un desglose falso.
  const taxCents = Number(invoice.tax_cents ?? 0);
  const taxRate = Number(invoice.tax_rate ?? 0);
  let taxes: Array<{ type: "VAT"; amount_in_cents: number }> | undefined;
  if (taxRate > 0 && taxCents > 0) {
    if (!Number.isSafeInteger(taxCents) || taxCents > amountCents) {
      logEvent({ level: "critical", event: "invoice_tax_invalid", invoice_id: invoice.id, tax_cents: taxCents, amount_cents: amountCents, action: "corregir tax_cents del comprobante" });
      return { ok: false, status: 409, error: "El comprobante tiene un impuesto inconsistente. Contacta a soporte." };
    }
    taxes = [{ type: "VAT", amount_in_cents: taxCents }];
  }
  const link = await createInternalPaymentLink({
    merchantTenantId: invoice.merchant_tenant_id ?? null,
    createdBy,
    idempotencyKey: `invoice:${invoice.id}:${crypto.randomUUID()}`,
    request: {
      amount_in_cents: amountCents,
      currency: invoice.currency,
      name: nameLabel,
      description: label.slice(0, 500),
      external_reference: `invoice:${invoice.id}`,
      metadata: { kind: "invoice", tenant_id: invoice.payer_tenant_id, invoice_id: invoice.id },
      ...(taxes ? { taxes } : {}),
      // Un redirect explícito (https) gana; sin él, el servicio usa su página de resultado.
      ...(redirectUrl && redirectUrl.startsWith("https://") ? { redirect_url: redirectUrl } : {}),
    },
  }, opts);

  // Condicionado al valor leido: dos peticiones concurrentes no se pisan; la perdedora
  // devuelve el link ganador (el suyo queda pendiente sin uso, nadie lo recibe).
  let upd = adminClient.from("payment_invoices").update({ payments_link_id: link.id }).eq("id", invoice.id);
  upd = invoice.payments_link_id ? upd.eq("payments_link_id", invoice.payments_link_id) : upd.is("payments_link_id", null);
  const { data: updated, error: updError } = await upd.select("id");
  if (updError) throw new Error(updError.message);
  if (!updated || updated.length === 0) {
    const { data: current } = await adminClient.from("payment_invoices").select("payments_link_id").eq("id", invoice.id).maybeSingle();
    const winner = current?.payments_link_id ? await getInternalPaymentLink(current.payments_link_id as string, opts) : null;
    if (winner && typeof winner.checkout_url === "string" && winner.checkout_url) return { ok: true, checkoutUrl: winner.checkout_url };
    throw new Error("No se pudo registrar el link de pago del comprobante.");
  }
  return { ok: true, checkoutUrl: link.checkoutUrl };
}
