// Dominio publico del SPA (leadly-app) y URL de retorno de pagos.
//
// Un unico lugar para el dominio por defecto de la app en el backend. Se puede
// sobrescribir con el secreto PUBLIC_APP_URL (mismo nombre que ya usa
// whatsapp-ai-tools para armar el enlace de la tienda).
//
// La pagina /pago/resultado del SPA es la que Wompi le muestra al NAVEGADOR de
// quien pago. NUNCA decide si el pago fue aprobado: solo consulta el estado que
// el backend ya conoce por el webhook (GET /v1/public/payment-links/{id}/status).

export const DEFAULT_PUBLIC_APP_URL = "https://leadly.lexycolombia.com";

/** Normaliza una base: https obligatorio (Wompi lo exige), sin credenciales, sin
 * barras finales ni query. Cualquier valor invalido cae al dominio por defecto. */
export function resolvePublicAppUrl(raw?: string | null): string {
  const value = (raw ?? "").trim();
  if (!value) return DEFAULT_PUBLIC_APP_URL;
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" || u.username || u.password) return DEFAULT_PUBLIC_APP_URL;
    return `${u.origin}${u.pathname}`.replace(/\/+$/, "");
  } catch {
    return DEFAULT_PUBLIC_APP_URL;
  }
}

/** Base configurada en el entorno (PUBLIC_APP_URL) o el dominio por defecto. */
export function publicAppUrl(): string {
  let env: string | undefined;
  try {
    env = Deno.env.get("PUBLIC_APP_URL");
  } catch {
    env = undefined; // sin permiso de lectura de env (pruebas): se usa el default
  }
  return resolvePublicAppUrl(env);
}

/** URL de retorno por defecto de un cobro: `${APP}/pago/resultado?link=<id>`.
 * `linkId` es el id de la fila propia (payments.payment_links.id): nunca el id de Wompi. */
export function paymentReturnUrl(linkId: string, base?: string | null): string {
  const root = base ? resolvePublicAppUrl(base) : publicAppUrl();
  return `${root}/pago/resultado?link=${encodeURIComponent(linkId)}`;
}
