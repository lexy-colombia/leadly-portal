import { supabase } from '../supabaseClient'
import type { Brand, ProductCategory } from '../../types/domain'

// Cliente de la tienda pública (marketplace) -- llama a la Edge Function
// `storefront`, pública y sin JWT (mismo criterio que whatsapp-webhook).
// `supabase.functions.invoke` funciona igual sin ninguna sesión iniciada: al
// no haber usuario logueado, supabase-js manda la anon key como
// Authorization, que esta función ni siquiera lee -- no hace falta un
// fetch() manual.

export interface StorefrontInfo {
  name: string
  logo_url: string | null
}

export interface StorefrontProductVariant {
  id: string
  label: string
  price: number
  /** Solo viene en list_products (para el selector rápido desde la grilla)
   * -- get_product no lo trae porque el detalle ya no necesita decidir si
   * habilitar el botón de agregar antes de que el cliente elija variante. */
  available?: number
}

export interface StorefrontProductSummary {
  id: string
  name: string
  sku: string | null
  brand_name: string | null
  price: number
  has_variants: boolean
  image_url: string | null
  categories: string[]
  /** null = el tenant no lleva control de inventario para este producto
   * (track_inventory=false), tratado como siempre disponible. Para un
   * producto con variantes, es la suma del stock de todas sus variantes. */
  available: number | null
  /** Solo presente cuando has_variants -- para el selector rápido de
   * variante desde la card, sin tener que entrar al detalle. */
  variants?: StorefrontProductVariant[]
}

export interface StorefrontProductDetail {
  id: string
  name: string
  description: string | null
  price: number
  has_variants: boolean
  categories: string[]
  images: { url: string; variant_id: string | null }[]
  variants: StorefrontProductVariant[]
}

export interface StorefrontCartItem {
  id: string
  product_id: string
  variant_id: string | null
  name: string
  variant_label: string | null
  quantity: number
  unit_price: number
  subtotal: number
  image_url: string | null
}

export interface CheckoutAddressInput {
  line1: string
  line2?: string
  city: string
  state_province?: string
  postal_code?: string
  country?: string
}

/** Una dirección ya guardada del contacto (`contact_addresses`) -- mismo
 * shape que usa el flujo de ventas de la IA (ver CLAUDE.md, "Módulo de
 * direcciones"), reutilizado acá para que el cliente que ya compró antes
 * elija una en vez de volver a tipearla. */
export interface StorefrontSavedAddress {
  id: string
  label: string | null
  recipient_name: string | null
  phone: string | null
  line1: string
  line2: string | null
  city: string | null
  state_province: string | null
  postal_code: string | null
  country: string | null
  /** Envío y facturación son roles independientes -- una dirección puede
   * servir para uno, el otro, o los dos (ver CLAUDE.md, "Módulo de
   * direcciones"). El picker de cada paso del checkout filtra por el flag
   * que corresponde. */
  is_shipping: boolean
  is_billing: boolean
  is_default: boolean
}

export interface VerifyOtpResult {
  verified: boolean
  /** Presente solo si ya existe un cliente con ese teléfono para este
   * tenant -- se revela recién acá porque es lo primero que pasa DESPUÉS de
   * probar que el visitante es dueño de ese WhatsApp (el código correcto),
   * nunca antes. */
  client: { full_name: string; document_type: string | null; document_number: string | null } | null
  addresses: StorefrontSavedAddress[]
}

/** Respuesta de get_order_status -- se consulta al volver del checkout
 * externo de Wompi (ver checkoutStorefrontCart's redirect_url), cuando ya no
 * queda nada en memoria de React porque el visitante recargó la página
 * entera al volver. */
export interface OrderStatusResult {
  order_number: number
  order_code: string
  total: number
  paid: boolean
}

export interface CheckoutResult {
  confirmed: boolean
  order_number: number
  order_code: string
  payment_method?: 'wompi' | 'credito'
  payment_charged?: boolean
  checkout_url?: string
  amount?: number
  payment_pending?: boolean
  payment_options?: ('wompi' | 'credito')[]
}

async function callStorefront<T>(action: string, params: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.functions.invoke<T & { error?: string }>('storefront', { body: { action, ...params } })
  if (error) {
    const context = (error as { context?: Response }).context
    if (context && typeof context.json === 'function') {
      try {
        const parsed = await context.json()
        if (parsed?.error) throw new Error(parsed.error)
      } catch (parseErr) {
        if (parseErr instanceof Error && parseErr.message) throw parseErr
      }
    }
    throw new Error(error.message)
  }
  return data as T
}

export function getStorefront(slug: string): Promise<StorefrontInfo> {
  return callStorefront('get_storefront', { slug })
}

/** Devuelve la fila completa de ProductCategory (no solo id/name) --
 * reutiliza el mismo CategoryTreeFilter + descendantIds que ya usa el
 * catálogo interno del tenant (Products.tsx), que esperan parent_category_id
 * para armar el árbol. */
export function listStorefrontCategories(slug: string): Promise<{ categories: ProductCategory[] }> {
  return callStorefront('list_categories', { slug })
}

export function listStorefrontBrands(slug: string): Promise<{ brands: Brand[] }> {
  return callStorefront('list_brands', { slug })
}

export function listStorefrontProducts(
  slug: string,
  opts?: { search?: string; category_ids?: string[]; brand_id?: string; sort?: string; offset?: number; limit?: number },
): Promise<{ products: StorefrontProductSummary[]; has_more: boolean }> {
  return callStorefront('list_products', { slug, ...opts })
}

export function getStorefrontProduct(slug: string, productId: string): Promise<StorefrontProductDetail> {
  return callStorefront('get_product', { slug, product_id: productId })
}

export function getStorefrontCart(sessionToken: string | null): Promise<{ status?: string; items: StorefrontCartItem[] }> {
  return callStorefront('get_cart', { session_token: sessionToken })
}

export function addToStorefrontCart(params: {
  slug: string
  session_token: string | null
  product_id: string
  variant_id?: string
  quantity: number
}): Promise<{ session_token: string; items: StorefrontCartItem[] }> {
  return callStorefront('add_to_cart', params)
}

export function updateStorefrontCartItem(sessionToken: string, itemId: string, quantity: number): Promise<{ items: StorefrontCartItem[] }> {
  return callStorefront('update_cart_item', { session_token: sessionToken, item_id: itemId, quantity })
}

export function removeStorefrontCartItem(sessionToken: string, itemId: string): Promise<{ items: StorefrontCartItem[] }> {
  return callStorefront('remove_cart_item', { session_token: sessionToken, item_id: itemId })
}

export function requestCheckoutOtp(sessionToken: string, phone: string): Promise<{ sent: boolean }> {
  return callStorefront('request_checkout_otp', { session_token: sessionToken, phone })
}

export function verifyCheckoutOtp(sessionToken: string, phone: string, code: string): Promise<VerifyOtpResult> {
  return callStorefront('verify_checkout_otp', { session_token: sessionToken, phone, code })
}

export function checkoutStorefrontCart(params: {
  session_token: string
  full_name: string
  phone: string
  document_type?: string
  document_number?: string
  /** Exactamente uno de los dos: reusar una dirección de envío ya guardada,
   * o cargar una nueva (que además queda guardada para la próxima compra). */
  address_id?: string
  address?: CheckoutAddressInput
  /** Default true en el backend si se omite -- factura a la misma dirección
   * de envío. En false, se necesita billing_address_id o billing_address
   * (misma lógica de "uno de los dos" que la de envío). */
  billing_same_as_shipping?: boolean
  billing_address_id?: string
  billing_address?: CheckoutAddressInput
  payment_method?: 'wompi' | 'credito'
  /** A dónde vuelve el cliente después de pagar en Wompi -- el browser es
   * quien sabe su propio origin real (ver storefront/index.ts::checkout),
   * más simple y confiable que hardcodear la URL de la tienda del lado del
   * servidor. */
  redirect_url?: string
}): Promise<CheckoutResult> {
  return callStorefront('checkout', params)
}

/** Se llama al volver del checkout externo de Wompi -- scoped por
 * session_token, nunca por un order_id suelto en la URL (ver
 * storefront/index.ts::get_order_status). */
export function getStorefrontOrderStatus(sessionToken: string): Promise<OrderStatusResult> {
  return callStorefront('get_order_status', { session_token: sessionToken })
}

/** Segundo paso cuando checkoutStorefrontCart devolvió payment_options (más
 * de un método disponible) -- a diferencia de volver a llamar
 * checkoutStorefrontCart (bug real: el pedido ya se creó y el carrito ya
 * quedó "converted" en esa primera llamada, así que un segundo checkout
 * choca con "Este carrito ya fue completado" y de paso duplicaría el
 * pedido), esta acción solo resuelve el pago sobre el pedido que ya existe. */
export function selectStorefrontPaymentMethod(params: {
  session_token: string
  payment_method: 'wompi' | 'credito'
  redirect_url?: string
}): Promise<CheckoutResult> {
  return callStorefront('select_payment_method', params)
}
