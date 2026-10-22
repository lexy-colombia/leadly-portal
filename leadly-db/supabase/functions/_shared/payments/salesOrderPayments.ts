import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { createInternalPaymentLink } from "../payments-service/internalLinks.ts";
import type { InternalLinkOptions } from "../payments-service/internalLinks.ts";

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
): Promise<{ id: string; tenantId: string; number: number; total: number; currency: string; balanceDue: number }> {
  const { data: order, error: orderError } = await adminClient
    .from("sales_orders")
    .select("id, tenant_id, number, status, total, currency")
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

  return { id: order.id, tenantId: order.tenant_id, number: order.number, total: order.total, currency: order.currency, balanceDue };
}

/** Creates a real Wompi payment link for a confirmed sales order, for its
 * exact remaining balance, THROUGH the unified payments service (in-process, as
 * Leadly's internal client, on behalf of the order's own tenant -- see
 * payments-service/internalLinks.ts). The link <-> order bridge is the service's
 * external_reference ("order:<id>") plus metadata {kind, tenant_id, order_id},
 * ALWAYS built here from the order row read on the server (never from a caller
 * parameter): payments-internal credits the payment against exactly that order
 * when Wompi confirms it. No taxes are sent (D7: the tenant's own prices carry
 * their own INC/IVA; the old fixed 19% was a Lexy convention). Called from
 * whatsapp-ai-tools, storefront and create-sales-order-payment-link -- same
 * rules for every caller. Fails closed if the internal client is not configured. */
export async function createSalesOrderPaymentLink(
  adminClient: SupabaseClient,
  tenantId: string,
  orderId: string,
  createdBy: string | null,
  // Opcional. Un redirectUrl explícito SIEMPRE gana (la tienda pública manda el
  // suyo, `?payment=return`, y su contrato no cambia). Sin él, el servicio manda al
  // comprador a /pago/resultado?link=<id del link del servicio>, que solo muestra el
  // estado que el backend ya conoce: nunca decide si el pago fue aprobado.
  redirectUrl?: string,
  // Solo pruebas: Deps/clientId inyectados.
  opts?: InternalLinkOptions,
): Promise<{ checkoutUrl: string; amount: number; orderCode: string }> {
  const order = await resolveConfirmedOrderBalance(adminClient, tenantId, orderId);
  const balanceDue = order.balanceDue;
  const orderCode = formatOrderCode(order.number);
  const currency = order.currency ?? "COP";
  if (currency !== "COP") throw new Error("Solo se pueden generar cobros en COP.");

  const link = await createInternalPaymentLink({
    // Comercio y metadata salen de la FILA del pedido (aislamiento de tenant).
    merchantTenantId: order.tenantId,
    createdBy,
    idempotencyKey: `order:${order.id}:${crypto.randomUUID()}`,
    request: {
      amount_in_cents: Math.round(balanceDue * 100),
      currency,
      name: `Pago pedido ${orderCode}`,
      description: `Pago pedido ${orderCode}`,
      external_reference: `order:${order.id}`,
      metadata: { kind: "order", tenant_id: order.tenantId, order_id: order.id },
      ...(redirectUrl ? { redirect_url: redirectUrl } : {}),
    },
  }, opts);

  return { checkoutUrl: link.checkoutUrl, amount: balanceDue, orderCode };
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
