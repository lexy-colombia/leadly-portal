// Wompi adapter -- ported from the proven `lexy` implementation
// (create-wompi-payment-link + wompi-webhook), generalized so credentials
// come from a resolved PaymentCredential + SecretGetter (Vault-backed, see
// payment_credential_secrets) instead of Deno.env.
import type {
  CheckoutParams,
  CheckoutResult,
  NormalizedPaymentEvent,
  PaymentCredential,
  PaymentProviderAdapter,
  SecretGetter,
} from "./types.ts";

function apiBaseFor(mode: string): string {
  return mode === "production" ? "https://production.wompi.co/v1" : "https://sandbox.wompi.co/v1";
}

function checkoutUrlFor(providerCheckoutId: string): string {
  return `https://checkout.wompi.co/l/${providerCheckoutId}`;
}

async function sha256Hex(input: string): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function resolvePath(obj: unknown, path: string): unknown {
  return path.split(".").reduce((val: unknown, part) => (val as Record<string, unknown> | undefined)?.[part], obj);
}

function extractPaymentDetails(tx: Record<string, unknown>) {
  const methodType = ((tx.payment_method_type as string) ?? "").toUpperCase();
  const method = (tx.payment_method ?? {}) as Record<string, unknown>;
  const extra = (method.extra ?? {}) as Record<string, string>;

  let brand: string | null = null;
  let lastFour: string | null = null;
  let bank: string | null = null;
  let reference = methodType;

  switch (methodType) {
    case "CARD":
      brand = (extra.brand ?? "").toUpperCase() || null;
      lastFour = extra.last_four ?? null;
      reference = [brand, lastFour ? `****${lastFour}` : null].filter(Boolean).join(" ") || "Tarjeta";
      break;
    case "PSE":
      bank = extra.bank_name ?? (method.financial_institution_code as string) ?? null;
      reference = `PSE${bank ? ` - ${bank}` : ""}`;
      break;
    case "NEQUI":
      reference = `Nequi${method.phone_number ? ` ${method.phone_number}` : ""}`;
      break;
    case "BANCOLOMBIA_TRANSFER":
      reference = "Bancolombia Transfer";
      break;
    case "BANCOLOMBIA_COLLECT":
      reference = "Bancolombia";
      break;
    default:
      reference = methodType || "Pago";
  }

  return { paymentMethod: methodType, paymentBrand: brand, paymentLastFour: lastFour, paymentBank: bank, paymentReference: reference };
}

function normalizeTransaction(tx: Record<string, unknown>): NormalizedPaymentEvent {
  const details = extractPaymentDetails(tx);
  return {
    providerCheckoutId: (tx.payment_link_id as string) ?? null,
    providerTransactionId: tx.id as string,
    status: tx.status as string,
    approved: tx.status === "APPROVED",
    amountCents: Number(tx.amount_in_cents ?? 0),
    currency: (tx.currency as string) ?? "COP",
    paymentMethod: details.paymentMethod,
    paymentBrand: details.paymentBrand,
    paymentLastFour: details.paymentLastFour,
    paymentBank: details.paymentBank,
    paymentReference: details.paymentReference,
    rawData: tx,
  };
}

export const wompiAdapter: PaymentProviderAdapter = {
  key: "wompi",

  checkoutUrlFor,

  async createCheckout(credential: PaymentCredential, getSecret: SecretGetter, params: CheckoutParams): Promise<CheckoutResult> {
    const privateKey = await getSecret("private_key");
    if (!privateKey) throw new Error("Wompi private_key not configured for this credential");

    // Leadly's amounts already include VAT (19%), same convention as lexy.
    const ivaCents = Math.round((params.amountCents * 19) / 119);
    const body = {
      name: params.description,
      // Wompi's /payment_links rejects the request with a 422
      // (INPUT_VALIDATION_ERROR, "description": "No está presente") without
      // this -- `name` and `description` are two separate required fields
      // on Wompi's side, not one. Lost when this adapter was ported from
      // lexy's original create-wompi-payment-link (which sends both, see
      // that function): this one only ever carried `name`. Found live
      // 2026-08-25, first real attempt to generate a sales-order link.
      description: params.description,
      single_use: true,
      collect_shipping: false,
      currency: params.currency,
      amount_in_cents: params.amountCents,
      sku: params.invoiceId,
      redirect_url: params.redirectUrl ?? null,
      taxes: [{ type: "VAT", amount_in_cents: ivaCents }],
    };

    const res = await fetch(`${apiBaseFor(credential.mode)}/payment_links`, {
      method: "POST",
      headers: { Authorization: `Bearer ${privateKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Wompi error creating payment link (${res.status}): ${errBody}`);
    }

    const data = await res.json();
    const providerCheckoutId = data.data.id as string;
    return { checkoutUrl: checkoutUrlFor(providerCheckoutId), providerCheckoutId };
  },

  async verifyWebhookSignature(payload: unknown, getSecret: SecretGetter): Promise<boolean> {
    const body = payload as {
      data?: { transaction?: Record<string, unknown> };
      signature?: { checksum: string; properties: string[] };
      timestamp?: number;
    };
    if (!body.data?.transaction || !body.signature?.checksum || !body.signature?.properties || !body.timestamp) {
      return false;
    }
    const integrityKey = await getSecret("integrity_key");
    if (!integrityKey) return false;

    const toHash =
      body.signature.properties.map((prop) => String(resolvePath(body.data, prop) ?? "")).join("") +
      String(body.timestamp) +
      integrityKey;
    const hashHex = await sha256Hex(toHash);
    return hashHex === body.signature.checksum;
  },

  parseWebhookEvent(payload: unknown): NormalizedPaymentEvent | null {
    const body = payload as { event?: string; data?: { transaction?: Record<string, unknown> } };
    if (body.event !== "transaction.updated" || !body.data?.transaction) return null;
    return normalizeTransaction(body.data.transaction);
  },

  async queryTransaction(credential: PaymentCredential, getSecret: SecretGetter, providerCheckoutId: string): Promise<NormalizedPaymentEvent | null> {
    const privateKey = await getSecret("private_key");
    if (!privateKey) throw new Error("Wompi private_key not configured for this credential");

    const res = await fetch(`${apiBaseFor(credential.mode)}/transactions?payment_link_id=${providerCheckoutId}`, {
      headers: { Authorization: `Bearer ${privateKey}` },
    });
    if (!res.ok) return null;

    const data = await res.json();
    const transactions = (data.data ?? []) as Record<string, unknown>[];
    const approved = transactions.find((tx) => tx.status === "APPROVED");
    const latest = approved ?? transactions[0];
    return latest ? normalizeTransaction(latest) : null;
  },
};
