import { supabase } from '../supabaseClient'
import { formatVariantLabel, getProductImageUrl } from './products'
import type { Client, OrderPaymentMethod, ProductImage, ProductOption, ProductVariant, SalesOrder } from '../../types/domain'

/** Punto de venta de mostrador. A diferencia de Órdenes (donde se arma una
 * cotización con calma, con autosave por `calculate-order`), acá el cajero
 * escanea y cobra en un solo viaje: toda la parte de negocio -- crear el
 * pedido, confirmarlo, descontar stock y registrar el pago -- vive en la
 * Edge Function `pos-checkout`, no en este archivo. Lo que sí resuelve el
 * frontend es la BÚSQUEDA (por código escaneado o por texto), porque el
 * cajero necesita ver el producto y su stock antes de agregarlo. */

export interface PosVariantOption {
  id: string
  label: string
  sku: string | null
  barcode: string | null
  /** Precio ya resuelto: el propio de la variante, o el del producto padre
   * cuando la variante no define uno (misma herencia que el resto de la
   * app -- ver lib/api/products.ts). */
  price: number
  /** null cuando el producto no lleva inventario (track_inventory=false):
   * "sin dato", no "cero". */
  available: number | null
}

export interface PosProduct {
  id: string
  name: string
  sku: string | null
  barcode: string | null
  price: number
  currency: string
  track_inventory: boolean
  has_variants: boolean
  image_url: string | null
  available: number | null
  variants: PosVariantOption[]
}

type ProductRow = {
  id: string
  name: string
  sku: string | null
  barcode: string | null
  retail_price: number | null
  currency: string
  track_inventory: boolean
  has_variants: boolean
  is_active: boolean
  images: ProductImage[]
  options: ProductOption[]
  variants: ProductVariant[]
}

const PRODUCT_SELECT =
  'id, name, sku, barcode, retail_price, currency, track_inventory, has_variants, is_active, images:product_images(*), options:product_options(*), variants:product_variants(*)'

/** Mismo escape que lib/api/products.ts -- `,` `(` `)` tienen significado
 * sintáctico dentro de un `.or()` de PostgREST y `%`/`_` son comodines de
 * ILIKE, así que un término que los contenga no puede corromper el filtro. */
function escapePostgrestPattern(term: string): string {
  return term.replace(/[,()%_]/g, '\\$&')
}

/** Suma de product_stock por producto y por variante, en UNA consulta,
 * acotada a los productos que se van a mostrar -- no la grilla completa del
 * tenant (esto corre en cada búsqueda del cajero, no una vez al cargar). */
async function loadStock(productIds: string[]): Promise<{ byProduct: Map<string, number>; byVariant: Map<string, number> }> {
  const byProduct = new Map<string, number>()
  const byVariant = new Map<string, number>()
  if (productIds.length === 0) return { byProduct, byVariant }

  const { data, error } = await supabase.from('product_stock').select('product_id, variant_id, quantity').in('product_id', productIds)
  if (error) throw error
  for (const row of data as { product_id: string; variant_id: string | null; quantity: number }[]) {
    byProduct.set(row.product_id, (byProduct.get(row.product_id) ?? 0) + row.quantity)
    if (row.variant_id) byVariant.set(row.variant_id, (byVariant.get(row.variant_id) ?? 0) + row.quantity)
  }
  return { byProduct, byVariant }
}

function toPosProduct(row: ProductRow, byProduct: Map<string, number>, byVariant: Map<string, number>): PosProduct {
  const price = row.retail_price ?? 0
  const activeVariants = (row.variants ?? []).filter((v) => v.is_active && !v.deleted_at)
  const image = (row.images ?? []).slice().sort((a, b) => a.display_order - b.display_order)[0]
  return {
    id: row.id,
    name: row.name,
    sku: row.sku,
    barcode: row.barcode,
    price,
    currency: row.currency,
    track_inventory: row.track_inventory,
    has_variants: row.has_variants,
    image_url: image ? getProductImageUrl(image.storage_path) : null,
    available: row.track_inventory ? (byProduct.get(row.id) ?? 0) : null,
    variants: activeVariants.map((v) => ({
      id: v.id,
      label: formatVariantLabel(v, row.options ?? []),
      sku: v.sku,
      barcode: v.barcode,
      price: v.retail_price ?? price,
      available: row.track_inventory ? (byVariant.get(v.id) ?? 0) : null,
    })),
  }
}

/** Búsqueda por texto sobre nombre/SKU/código de barras del producto, más
 * los SKU/códigos de sus variantes (dos consultas en paralelo cuyos ids se
 * unen) -- si el cajero teclea el código de una variante puntual, el
 * producto padre tiene que aparecer igual. */
export async function searchPosProducts(tenantId: string, term: string, limit = 20): Promise<PosProduct[]> {
  const clean = term.trim()
  if (!clean) return []
  const pattern = escapePostgrestPattern(clean)

  const [{ data: direct, error: directError }, { data: variantHits, error: variantError }] = await Promise.all([
    supabase
      .from('products')
      .select(PRODUCT_SELECT)
      .eq('tenant_id', tenantId)
      .eq('is_active', true)
      .is('deleted_at', null)
      .or(`name.ilike.%${pattern}%,sku.ilike.%${pattern}%,barcode.ilike.%${pattern}%`)
      .order('name')
      .limit(limit),
    supabase
      .from('product_variants')
      .select('product_id')
      .eq('tenant_id', tenantId)
      .is('deleted_at', null)
      .or(`sku.ilike.%${pattern}%,barcode.ilike.%${pattern}%`)
      .limit(limit),
  ])
  if (directError) throw directError
  if (variantError) throw variantError

  const rows = (direct ?? []) as unknown as ProductRow[]
  const foundIds = new Set(rows.map((r) => r.id))
  const missingIds = Array.from(new Set((variantHits ?? []).map((r) => (r as { product_id: string }).product_id))).filter((id) => !foundIds.has(id))

  if (missingIds.length > 0) {
    const { data: extra, error: extraError } = await supabase
      .from('products')
      .select(PRODUCT_SELECT)
      .eq('tenant_id', tenantId)
      .eq('is_active', true)
      .is('deleted_at', null)
      .in('id', missingIds)
    if (extraError) throw extraError
    rows.push(...((extra ?? []) as unknown as ProductRow[]))
  }

  const sliced = rows.slice(0, limit)
  const { byProduct, byVariant } = await loadStock(sliced.map((r) => r.id))
  return sliced.map((row) => toPosProduct(row, byProduct, byVariant)).sort((a, b) => a.name.localeCompare(b.name))
}

export interface PosBarcodeMatch {
  product: PosProduct
  /** La variante concreta cuando el código escaneado era de una variante --
   * null cuando el código era el del producto padre (ahí el cajero elige la
   * variante a mano, si el producto tiene). */
  variant: PosVariantOption | null
}

/** Resolución EXACTA de un código escaneado (no ilike): primero contra las
 * variantes -- un código de variante es más específico que el del padre --
 * y si no, contra el producto. */
export async function lookupPosBarcode(tenantId: string, code: string): Promise<PosBarcodeMatch | null> {
  const clean = code.trim()
  if (!clean) return null

  const { data: variantRow, error: variantError } = await supabase
    .from('product_variants')
    .select('id, product_id')
    .eq('tenant_id', tenantId)
    .eq('barcode', clean)
    .is('deleted_at', null)
    .maybeSingle()
  if (variantError) throw variantError

  const query = supabase.from('products').select(PRODUCT_SELECT).eq('tenant_id', tenantId).is('deleted_at', null).eq('is_active', true)
  const { data: row, error } = variantRow
    ? await query.eq('id', (variantRow as { product_id: string }).product_id).maybeSingle()
    : await query.eq('barcode', clean).maybeSingle()
  if (error) throw error
  if (!row) return null

  const productRow = row as unknown as ProductRow
  const { byProduct, byVariant } = await loadStock([productRow.id])
  const product = toPosProduct(productRow, byProduct, byVariant)
  const variantId = variantRow ? (variantRow as { id: string }).id : null
  return { product, variant: variantId ? (product.variants.find((v) => v.id === variantId) ?? null) : null }
}

/** Cliente "Consumidor Final" del tenant (uno solo, sembrado por
 * seed_default_walkin_client) -- el default de toda venta de mostrador.
 * Se carga solo para mostrar su nombre en la UI: si el checkout va sin
 * contact_id, `pos-checkout` lo resuelve igual del lado del servidor. */
export async function getWalkInClient(tenantId: string): Promise<Client | null> {
  const { data, error } = await supabase.from('clients').select('*').eq('tenant_id', tenantId).eq('is_walk_in', true).is('deleted_at', null).maybeSingle()
  if (error) throw error
  return data
}

/** Búsqueda de cliente para identificar la venta (opcional) -- por nombre,
 * documento o teléfono, que es lo que el cajero tiene a mano en el
 * mostrador. */
export async function searchPosClients(tenantId: string, term: string, limit = 8): Promise<Client[]> {
  const clean = term.trim()
  if (!clean) return []
  const pattern = escapePostgrestPattern(clean)
  const { data, error } = await supabase
    .from('clients')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('is_active', true)
    .is('deleted_at', null)
    .or(`full_name.ilike.%${pattern}%,document_number.ilike.%${pattern}%,phone.ilike.%${pattern}%`)
    .order('full_name')
    .limit(limit)
  if (error) throw error
  return data
}

/** Mismo catálogo que el resto de la app (PAYMENT_METHOD_LABEL_KEY en
 * orderPayments.ts) menos 'wompi' -- ese método solo lo escribe
 * payment-webhook-wompi cuando un link se paga de verdad, nunca una
 * selección manual del cajero. */
export type PosPaymentMethod = Exclude<OrderPaymentMethod, 'wompi'>

export interface PosCheckoutInput {
  contact_id?: string | null
  items: { product_id: string; variant_id?: string | null; quantity: number }[]
  payment: { method: PosPaymentMethod; amount: number; amount_tendered?: number }
}

export interface PosCheckoutResult {
  order: Pick<SalesOrder, 'id' | 'number' | 'subtotal' | 'total' | 'tax_total' | 'currency'>
  invoice: { id: string; status: string; cufe: string | null; status_detail: string | null } | null
}

/** Una sola llamada: crea el pedido, lo confirma (con el chequeo de stock
 * real del trigger) y registra el pago. El precio de cada línea lo resuelve
 * el servidor contra `products` -- lo que se manda desde acá es solo QUÉ y
 * CUÁNTO, nunca a cuánto (un escáner es un teclado, no una fuente de
 * verdad). */
export async function posCheckout(input: PosCheckoutInput): Promise<PosCheckoutResult> {
  const { data, error } = await supabase.functions.invoke<PosCheckoutResult & { error?: string }>('pos-checkout', { body: input })
  // Un 4xx/5xx de la función llega como FunctionsHttpError con el cuerpo sin
  // parsear -- mismo patrón que lib/api/orders.ts: leerlo para poder mostrar
  // el mensaje real ("Stock insuficiente para...") en vez de un genérico.
  if (error) {
    const context = (error as { context?: Response }).context
    if (context && typeof context.json === 'function') {
      let specificMessage: string | undefined
      try {
        const responseBody = await context.json()
        specificMessage = responseBody?.error
      } catch {
        /* fall through to generic error */
      }
      if (specificMessage) throw new Error(specificMessage)
    }
    throw error
  }
  if (data?.error) throw new Error(data.error)
  return data as PosCheckoutResult
}
