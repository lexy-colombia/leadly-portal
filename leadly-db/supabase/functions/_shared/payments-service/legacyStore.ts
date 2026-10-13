// Implementacion real de LegacyStore sobre supabase-js (service role): lee
// public.payment_invoices / public.sales_order_payment_links y reutiliza
// applyWebhookEvent / applySalesOrderPaymentWebhookEvent para escribir (mismo
// contrato que tenian bajo payment-webhook-wompi, que se retiro).
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { applyWebhookEvent } from "../payments/applyWebhookEvent.ts";
import { applySalesOrderPaymentWebhookEvent } from "../payments/salesOrderPayments.ts";
import { makeSecretGetter, resolveCredential } from "../payments/registry.ts";
import { wompiAdapter } from "../payments/wompi.ts";
import type { LegacyStore, LegacyTarget, PublicLinkStatus } from "./types.ts";

function toCents(amount: unknown): number | null {
  const n = typeof amount === "string" ? Number(amount) : (amount as number);
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

export function createLegacyStore(admin: SupabaseClient): LegacyStore {
  return {
    async find(wompiLinkId) {
      // (2) factura de plataforma (Lexy -> tenant). provider_checkout_id NO es unico
      // en esa tabla: mas de una fila = ambiguo, no se paga nada.
      const inv = await admin
        .from("payment_invoices")
        .select("id, merchant_tenant_id, status, amount_cents, currency, provider_transaction_id, deleted_at")
        .eq("provider_checkout_id", wompiLinkId)
        .limit(2);
      if (inv.error) throw new Error(inv.error.message);
      if (inv.data && inv.data.length > 1) return "ambiguous";
      if (inv.data && inv.data.length === 1) {
        const r = inv.data[0];
        return {
          origin: "invoice",
          id: r.id,
          wompiLinkId,
          merchantTenantId: r.merchant_tenant_id ?? null,
          status: r.status,
          expectedCents: typeof r.amount_cents === "number" ? r.amount_cents : null,
          currency: r.currency ?? null,
          deleted: r.deleted_at !== null && r.deleted_at !== undefined,
          appliedTransactionId: r.status === "PAID" ? (r.provider_transaction_id ?? null) : null,
        } satisfies LegacyTarget;
      }

      // (3) link de cobro de un tenant a su cliente.
      const link = await admin
        .from("sales_order_payment_links")
        .select("id, tenant_id, status, amount, currency")
        .eq("provider_key", "wompi")
        .eq("provider_checkout_id", wompiLinkId)
        .limit(2);
      if (link.error) throw new Error(link.error.message);
      if (link.data && link.data.length > 1) return "ambiguous";
      if (link.data && link.data.length === 1) {
        const r = link.data[0];
        let applied: string | null = null;
        if (r.status === "paid") {
          const p = await admin
            .from("sales_order_payments")
            .select("provider_transaction_id")
            .eq("payment_link_id", r.id)
            .is("deleted_at", null)
            .limit(1);
          if (p.error) throw new Error(p.error.message);
          applied = p.data?.[0]?.provider_transaction_id ?? null;
        }
        return {
          origin: "order_link",
          id: r.id,
          wompiLinkId,
          merchantTenantId: r.tenant_id,
          status: r.status,
          expectedCents: toCents(r.amount),
          currency: r.currency ?? null,
          deleted: false, // sales_order_payment_links no tiene soft-delete
          appliedTransactionId: applied,
        } satisfies LegacyTarget;
      }
      return null;
    },

    async publicStatus(id) {
      // Solo lectura, por id propio (UUID ya validado por el router). Se devuelve
      // unicamente estado y fecha: nada del monto, pedido, tenant ni proveedor.
      const inv = await admin
        .from("payment_invoices")
        .select("status, updated_at, deleted_at")
        .eq("id", id)
        .maybeSingle();
      if (inv.error) throw new Error(inv.error.message);
      if (inv.data) {
        if (inv.data.deleted_at !== null && inv.data.deleted_at !== undefined) return null;
        const map: Record<string, PublicLinkStatus> = {
          PENDING: "pending", OVERDUE: "pending", PAID: "paid", CANCELLED: "cancelled", REFUNDED: "voided",
        };
        return { status: map[String(inv.data.status)] ?? "unknown", updatedAt: inv.data.updated_at ?? null };
      }
      const link = await admin
        .from("sales_order_payment_links")
        .select("status, updated_at")
        .eq("id", id)
        .maybeSingle();
      if (link.error) throw new Error(link.error.message);
      if (link.data) {
        const map: Record<string, PublicLinkStatus> = { pending: "pending", paid: "paid", expired: "expired", cancelled: "cancelled" };
        return { status: map[String(link.data.status)] ?? "unknown", updatedAt: link.data.updated_at ?? null };
      }
      return null;
    },

    async getCredential(merchantTenantId) {
      try {
        const credential = await resolveCredential(admin, merchantTenantId, "wompi");
        return { mode: credential.mode, getSecret: makeSecretGetter(admin, credential.id) };
      } catch {
        return null;
      }
    },

    async transactionUsedElsewhere(transactionId, target) {
      // Pagos de pedidos ya registrados con esa transaccion bajo OTRO link.
      const pay = await admin
        .from("sales_order_payments")
        .select("payment_link_id")
        .eq("provider_transaction_id", transactionId)
        .is("deleted_at", null)
        .limit(5);
      if (pay.error) throw new Error(pay.error.message);
      for (const p of pay.data ?? []) {
        if (target.origin !== "order_link" || p.payment_link_id !== target.id) return true;
      }
      // Facturas de plataforma pagadas con esa transaccion (otra factura).
      const inv = await admin
        .from("payment_invoices")
        .select("id")
        .eq("provider_transaction_id", transactionId)
        .limit(5);
      if (inv.error) throw new Error(inv.error.message);
      for (const i of inv.data ?? []) {
        if (target.origin !== "invoice" || i.id !== target.id) return true;
      }
      // Intentos registrados contra OTRA factura con la misma transaccion.
      const att = await admin
        .from("payment_attempts")
        .select("invoice_id")
        .eq("provider_transaction_id", transactionId)
        .limit(5);
      if (att.error) throw new Error(att.error.message);
      for (const a of att.data ?? []) {
        if (target.origin !== "invoice" || a.invoice_id !== target.id) return true;
      }
      return false;
    },

    async apply(target, tx) {
      const event = wompiAdapter.parseWebhookEvent({ event: "transaction.updated", data: { transaction: tx } });
      if (!event || !event.providerCheckoutId) return { handled: false };
      if (target.origin === "invoice") {
        const r = await applyWebhookEvent(admin, "wompi", event, { atomicClaim: true });
        return { handled: r.handled };
      }
      if (!event.approved) return { handled: false };
      const r = await applySalesOrderPaymentWebhookEvent(admin, "wompi", event.providerCheckoutId, {
        approved: event.approved,
        providerTransactionId: event.providerTransactionId,
        amountCents: event.amountCents,
        paymentReference: event.paymentReference,
      });
      return { handled: r.handled };
    },
  };
}
