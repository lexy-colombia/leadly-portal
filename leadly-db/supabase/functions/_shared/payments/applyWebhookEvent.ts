import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import type { NormalizedPaymentEvent } from "./types.ts";

// Shared by every payment-webhook-<provider> function (and by
// sync-payment-invoices for reconciliation) so idempotency and the
// PAID-transition logic live in exactly one place, not duplicated per
// provider. Same idempotency guard as the lexy implementation: only acts if
// the invoice is still PENDING/OVERDUE, so a re-delivered webhook or a
// reconciliation pass that races the webhook can never double-process.
export async function applyWebhookEvent(
  adminClient: SupabaseClient,
  providerKey: string,
  event: NormalizedPaymentEvent,
): Promise<{ handled: boolean; invoiceId?: string }> {
  if (!event.providerCheckoutId) return { handled: false };

  const { data: invoice } = await adminClient
    .from("payment_invoices")
    .select("id, status")
    .eq("provider_checkout_id", event.providerCheckoutId)
    .maybeSingle();

  if (!invoice) return { handled: false };
  if (invoice.status !== "PENDING" && invoice.status !== "OVERDUE") return { handled: false };

  await adminClient.from("payment_attempts").insert({
    invoice_id: invoice.id,
    provider_key: providerKey,
    provider_transaction_id: event.providerTransactionId,
    status: event.status,
    amount_cents: event.amountCents,
    currency: event.currency,
    payment_method: event.paymentMethod,
    payment_brand: event.paymentBrand,
    payment_last_four: event.paymentLastFour,
    payment_bank: event.paymentBank,
    payment_reference: event.paymentReference,
    raw_data: event.rawData,
  });

  if (event.approved) {
    // billing_subscriptions activation/extension is handled by the
    // activate_subscription_on_invoice_paid trigger, not here.
    await adminClient
      .from("payment_invoices")
      .update({
        status: "PAID",
        provider_transaction_id: event.providerTransactionId,
        provider_payment_method: event.paymentMethod,
        provider_payment_data: event.rawData,
      })
      .eq("id", invoice.id);
  }

  return { handled: true, invoiceId: invoice.id };
}
