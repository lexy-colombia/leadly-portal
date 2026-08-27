// El session_token del carrito de invitado vive en localStorage, no en la
// URL ni en un cookie -- namespaced por slug porque un mismo visitante podría
// en teoría visitar la tienda de más de un tenant desde el mismo navegador.
function storageKey(slug: string): string {
  return `leadly:storefront-cart:${slug}`
}

export function getStorefrontCartToken(slug: string): string | null {
  return localStorage.getItem(storageKey(slug))
}

export function setStorefrontCartToken(slug: string, token: string): void {
  localStorage.setItem(storageKey(slug), token)
}

export function clearStorefrontCartToken(slug: string): void {
  localStorage.removeItem(storageKey(slug))
}

/** Lo mínimo para no tener que repetir el paso de identificarte (documento +
 * teléfono) si se recarga la página estando ya verificado -- sessionStorage
 * a propósito (no localStorage): se pierde solo al cerrar la pestaña, mismo
 * espíritu que la ventana de 30 minutos que ya tiene la verificación del
 * lado del servidor (OTP_VERIFIED_VALID_MINUTES), no hace falta que
 * sobreviva más que eso. El backend (get_verified_identity) sigue siendo
 * quien decide si esto todavía es válido -- esto solo evita mostrar el
 * formulario de OTP de nuevo mientras se confirma. */
function identityStorageKey(slug: string): string {
  return `leadly:storefront-identity:${slug}`
}

export interface StorefrontIdentityDraft {
  phone: string
  documentType: string
  documentNumber: string
}

export function getStorefrontIdentityDraft(slug: string): StorefrontIdentityDraft | null {
  const raw = sessionStorage.getItem(identityStorageKey(slug))
  if (!raw) return null
  try {
    return JSON.parse(raw) as StorefrontIdentityDraft
  } catch {
    return null
  }
}

export function setStorefrontIdentityDraft(slug: string, draft: StorefrontIdentityDraft): void {
  sessionStorage.setItem(identityStorageKey(slug), JSON.stringify(draft))
}

export function clearStorefrontIdentityDraft(slug: string): void {
  sessionStorage.removeItem(identityStorageKey(slug))
}
