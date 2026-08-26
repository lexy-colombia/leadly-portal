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
  opts?: { search?: string; category_ids?: string[]; brand_id?: string; sort?: string },
): Promise<{ products: StorefrontProductSummary[] }> {
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

export function verifyCheckoutOtp(sessionToken: string, phone: string, code: string): Promise<{ verified: boolean }> {
  return callStorefront('verify_checkout_otp', { session_token: sessionToken, phone, code })
}

export function checkoutStorefrontCart(params: {
  session_token: string
  full_name: string
  phone: string
  address: CheckoutAddressInput
  payment_method?: 'wompi' | 'credito'
}): Promise<CheckoutResult> {
  return callStorefront('checkout', params)
}
