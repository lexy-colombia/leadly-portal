// Provider adapter minimo (registry.ts). Creacion de links y eventos viven en
// payments-service; el adaptador solo sabe la URL publica del checkout.

export interface PaymentCredential {
  id: string;
  providerKey: string;
  mode: "sandbox" | "production";
  config: Record<string, unknown>;
}

export type SecretGetter = (secretName: string) => Promise<string | null>;

export interface PaymentProviderAdapter {
  key: string;
  checkoutUrlFor(providerCheckoutId: string): string;
}
