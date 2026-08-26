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
