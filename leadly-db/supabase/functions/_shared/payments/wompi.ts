// Wompi adapter. Solo conserva lo que aun usa el servicio de pagos
// (payments-service/wompiLinks.ts): la URL publica del checkout de un link. La
// creacion de links, el receptor de eventos y la confirmacion de transacciones
// viven en payments-service; este adaptador ya no crea ni recibe nada.
import type { PaymentProviderAdapter } from "./types.ts";

function checkoutUrlFor(providerCheckoutId: string): string {
  return `https://checkout.wompi.co/l/${providerCheckoutId}`;
}

export const wompiAdapter: PaymentProviderAdapter = {
  key: "wompi",
  checkoutUrlFor,
};
