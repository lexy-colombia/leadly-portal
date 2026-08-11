// Generic payment-provider adapter interface. Adding a new provider (Stripe,
// MercadoPago, ...) means implementing this interface in its own file and
// registering it in registry.ts -- nothing else in the payments module
// (create-payment-checkout, payment-webhook-<provider>, sync-payment-invoices,
// applyWebhookEvent.ts) needs to change.

export interface PaymentCredential {
  id: string;
  providerKey: string;
  mode: "sandbox" | "production";
  config: Record<string, unknown>;
}

export type SecretGetter = (secretName: string) => Promise<string | null>;

export interface CheckoutParams {
  invoiceId: string;
  amountCents: number;
  currency: string;
  description: string;
  redirectUrl?: string;
}

export interface CheckoutResult {
  checkoutUrl: string;
  providerCheckoutId: string;
}

export interface NormalizedPaymentEvent {
  providerCheckoutId: string | null;
  providerTransactionId: string;
  status: string;
  approved: boolean;
  amountCents: number;
  currency: string;
  paymentMethod: string;
  paymentBrand: string | null;
  paymentLastFour: string | null;
  paymentBank: string | null;
  paymentReference: string;
  rawData: unknown;
}

export interface PaymentProviderAdapter {
  key: string;
  checkoutUrlFor(providerCheckoutId: string): string;
  createCheckout(credential: PaymentCredential, getSecret: SecretGetter, params: CheckoutParams): Promise<CheckoutResult>;
  verifyWebhookSignature(payload: unknown, getSecret: SecretGetter): Promise<boolean>;
  parseWebhookEvent(payload: unknown): NormalizedPaymentEvent | null;
  queryTransaction(credential: PaymentCredential, getSecret: SecretGetter, providerCheckoutId: string): Promise<NormalizedPaymentEvent | null>;
}
