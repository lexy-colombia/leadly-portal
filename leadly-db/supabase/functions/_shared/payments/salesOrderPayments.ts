import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { getAdapter, makeSecretGetter, resolveCredential } from "./registry.ts";
import { paymentReturnUrl } from "../publicAppUrl.ts";

function formatOrderCode(number: number): string {
  return String(number).padStart(3, "0");
}

/** Loads a confirmed order and its exact remaining balance -- shared by
 * every path that charges a customer (Wompi link, credit charge), so the
 * amount is always computed the same way, from the order's own total minus
 * its recorded payments, and never accepted as a parameter from a caller
 * (AI or human). Throws with a customer-facing-safe message if the order
 * isn't confirmed yet or is already fully paid. */
async function resolveConfirmedOrderBalance(
  adminClient: SupabaseClient,
  tenantId: string,
  orderId: string,
): Promise<{ id: string; number: number; total: number; currency: string; balanceDue: number }> {
  const { data: order, error: orderError } = await adminClient
    .from("sales_orders")
    .select("id, number, status, total, currency")
    .eq("id", orderId)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  if (orderError) throw new Error(orderError.message);
  if (!order) throw new Error("No se encontró el pedido.");
  if (order.status !== "confirmada") throw new Error("Solo se puede generar un cobro para un pedido ya confirmado.");

  const { data: payments, error: paymentsError } = await adminClient
    .from("sales_order_payments")
    .select("amount")
    .eq("order_id", orderId)
    .is("deleted_at", null);
  if (paymentsError) throw new Error(paymentsError.message);
  const totalPaid = (payments ?? []).reduce((sum: number, p: { amount: number }) => sum + p.amount, 0);
  const balanceDue = Math.round((order.total - totalPaid) * 100) / 100;
  if (balanceDue <= 0) throw new Error("Este pedido ya está pagado por completo.");

  return { id: order.id, number: order.number, total: order.total, currency: order.currency, balanceDue };
}

/** Creates a real Wompi payment link for a confirmed sales order, for its
 * exact remaining balance. Persists a sales_order_payment_links row so
 * payments-api (/v1/events/wompi) can find its way back to this specific order once
 * the customer actually pays -- without this bridge (which didn't exist
 * before 2026-08-25), a completed Wompi payment had nowhere to land: the
 * checkout worked but the order never found out. Called from both
 * whatsapp-ai-tools (generate_payment_link) and
 * create-sales-order-payment-link (the human-agent action from the order's
 * own screen) -- same rules either way. */
export async function createSalesOrderPaymentLink(
  adminClient: SupabaseClient,
  tenantId: string,
  orderId: string,
  createdBy: string | null,
  // Opcional. Un redirectUrl explícito SIEMPRE gana (la tienda pública manda el
  // suyo, `?payment=return`, y su contrato no cambia). Sin él, el comprador
  // vuelve a la página pública de resultado del SPA (/pago/resultado?link=<id de
  // esta fila>), que solo muestra el estado que el backend ya conoce por el
  // webhook: nunca decide si el pago fue aprobado.
  redirectUrl?: string,
): Promise<{ checkoutUrl: string; amount: number; orderCode: string }> {
  const order = await resolveConfirmedOrderBalance(adminClient, tenantId, orderId);
  const balanceDue = order.balanceDue;

  const credential = await resolveCredential(adminClient, tenantId, "wompi");
  const getSecret = makeSecretGetter(adminClient, credential.id);
  const adapter = getAdapter("wompi");
  const orderCode = formatOrderCode(order.number);
  const currency = order.currency ?? "COP";

  // El id de la fila se genera ANTES de crear el checkout para poder armar el
  // redirect por defecto con él; se inserta la fila con ese mismo id.
  const linkRowId = crypto.randomUUID();
  const result = await adapter.createCheckout(credential, getSecret, {
    invoiceId: `order-${order.number}-${Date.now()}`,
    amountCents: Math.round(balanceDue * 100),
    currency,
    description: `Pago pedido ${orderCode}`,
    redirectUrl: redirectUrl ?? paymentReturnUrl(linkRowId),
  });

  const { error: linkError } = await adminClient.from("sales_order_payment_links").insert({
    id: linkRowId,
    tenant_id: tenantId,
    order_id: orderId,
    provider_key: "wompi",
    provider_checkout_id: result.providerCheckoutId,
    checkout_url: result.checkoutUrl,
    amount: balanceDue,
    currency,
    created_by: createdBy,
  });
  if (linkError) throw new Error(linkError.message);

  return { checkoutUrl: result.checkoutUrl, amount: balanceDue, orderCode };
}

/** Charges a confirmed sales order's exact remaining balance to the
 * client's credit account -- the WhatsApp-AI counterpart to an agent
 * manually picking method "credito" in PaymentDrawer.tsx. Deliberately just
 * an insert into sales_order_payments: the existing DB trigger
 * apply_credit_payment_charge() (20260822020001_customer_credit.sql)
 * re-validates clients.credit_enabled itself and creates the linked
 * credit_charges row -- inserting there directly would bypass that
 * trigger's validation and the unique sales_order_payment_id constraint it
 * relies on. Same "amount is always the real balance, never a caller
 * parameter" rule as createSalesOrderPaymentLink above. */
export async function chargeSalesOrderToCredit(
  adminClient: SupabaseClient,
  tenantId: string,
  clientId: string,
  orderId: string,
): Promise<{ amount: number; orderCode: string }> {
  const { data: client, error: clientError } = await adminClient.from("clients").select("credit_enabled").eq("id", clientId).maybeSingle();
  if (clientError) throw new Error(clientError.message);
  if (!client?.credit_enabled) throw new Error("Este cliente no tiene crédito habilitado.");

  const order = await resolveConfirmedOrderBalance(adminClient, tenantId, orderId);

  const { error: paymentError } = await adminClient.from("sales_order_payments").insert({
    tenant_id: tenantId,
    order_id: orderId,
    method: "credito",
    amount: order.balanceDue,
    currency: order.currency ?? "COP",
    notes: "Cargado a crédito por WhatsApp (IA).",
  });
  if (paymentError) throw new Error(paymentError.message);

  return { amount: order.balanceDue, orderCode: formatOrderCode(order.number) };
}

/** The receiving half of the bridge above -- called from payments-api (/v1/events/wompi)
 * after a `payment_invoices` lookup misses (that table is Leadly's own SaaS
 * billing to its tenants, a completely different concern, see that
 * function's header). Idempotent the same way applyWebhookEvent.ts is: a
 * link only gets acted on while still "pending", and
 * sales_order_payments_payment_link_idx (a partial unique index) makes a
 * second insert for the same link impossible even if this ran twice
 * concurrently -- caught and treated as already-handled, not an error. */
export async function applySalesOrderPaymentWebhookEvent(
  adminClient: SupabaseClient,
  providerKey: string,
  providerCheckoutId: string,
  event: {
    approved: boolean;
    providerTransactionId: string;
    amountCents: number;
    paymentReference: string | null;
  },
): Promise<{ handled: boolean; orderId?: string }> {
  const { data: link } = await adminClient
    .from("sales_order_payment_links")
    .select("id, tenant_id, order_id, status")
    .eq("provider_key", providerKey)
    .eq("provider_checkout_id", providerCheckoutId)
    .maybeSingle();
  if (!link) return { handled: false };
  if (link.status !== "pending") return { handled: false };
  if (!event.approved) return { handled: false };

  const { error: insertError } = await adminClient.from("sales_order_payments").insert({
    tenant_id: link.tenant_id,
    order_id: link.order_id,
    method: "wompi",
    amount: Math.round(event.amountCents) / 100,
    provider_key: providerKey,
    provider_transaction_id: event.providerTransactionId,
    provider_reference: event.paymentReference,
    payment_link_id: link.id,
  });
  if (insertError) {
    // 23505 = violacion de un indice unico. Se distingue POR NOMBRE de constraint:
    //  - sales_order_payments_payment_link_idx: ya hay un pago para este link (una
    //    reentrega concurrente que gano la carrera) -> ya manejado, no es un fallo.
    //  - sales_order_payments_wompi_transaction_uidx (propuesta 20261011210100): la
    //    MISMA transaccion ya acredito otro pago -> conflicto real, NUNCA "ya manejado".
    //  - cualquier otro 23505: se conserva el comportamiento historico (ya manejado).
    if (insertError.code === "23505") {
      const msg = `${insertError.message ?? ""} ${(insertError as { details?: string }).details ?? ""}`;
      if (msg.includes("sales_order_payments_wompi_transaction_uidx")) {
        throw new Error("transaction_already_applied_to_another_payment");
      }
      return { handled: true, orderId: link.order_id };
    }
    throw new Error(insertError.message);
  }

  await adminClient.from("sales_order_payment_links").update({ status: "paid" }).eq("id", link.id);

  return { handled: true, orderId: link.order_id };
}
