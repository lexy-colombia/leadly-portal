import { supabase } from '../supabaseClient'
import type { Product, ProductImage, ProductOption, ProductVariant } from '../../types/domain'
import type { TranslationKey } from '../../i18n/translations'
import { listProductIdsWithWarehouseStock, listStockTotalsByTenant } from './stockMovements'

export interface ProductInput {
  tenant_id: string
  name: string
  description?: string | null
  sku?: string | null
  slug?: string | null
  supplier_id?: string | null
  brand_id?: string | null
  purchase_price?: number | null
  wholesale_price?: number | null
  retail_price?: number | null
  currency?: string
  track_inventory?: boolean
  low_stock_threshold?: number
  is_active?: boolean
  has_variants?: boolean
}

export interface ProductCategoryRef {
  id: string
  name: string
  parent_category_id: string | null
}

/** A product is linked to its whole category ancestor chain, not just the
 * leaf it was actually filed under (see core_catalog.sql/
 * product_category_links) -- but that join has no guaranteed order, so
 * ProductDetail.tsx would show e.g. "Adaptadores HDMI, Adaptadores y
 * cables" with no way to tell which one is the parent. This orders the
 * chain root -> leaf and joins it as "Adaptadores y cables › Adaptadores
 * HDMI". Depth is computed by walking parent_category_id only through
 * ancestors that are also in this product's own set -- a category whose
 * parent isn't among them (chain cut short, e.g. a stale ancestor) is just
 * treated as its own root instead of breaking the sort. Multiple root
 * categories (a product filed under two unrelated branches) sort
 * alphabetically relative to each other, each followed by its own children. */
export function formatCategoryHierarchy(categories: ProductCategoryRef[]): string {
  function depth(category: ProductCategoryRef, seen: Set<string>): number {
    if (seen.has(category.id)) return 0 // guards against a cyclic parent chain, if one ever slips in
    const parent = category.parent_category_id ? categories.find((c) => c.id === category.parent_category_id) : undefined
    return parent ? 1 + depth(parent, new Set(seen).add(category.id)) : 0
  }
  return [...categories]
    .map((c) => ({ c, depth: depth(c, new Set()) }))
    .sort((a, b) => a.depth - b.depth || a.c.name.localeCompare(b.c.name))
    .map(({ c }) => c.name)
    .join(' › ')
}

export type ProductWithImages = Product & {
  images: ProductImage[]
  categories: ProductCategoryRef[]
  supplier: { id: string; name: string } | null
  brand: { id: string; name: string } | null
  options: ProductOption[]
  variants: ProductVariant[]
}

/** Sorts option values in their declared order (product cartesian below
 * relies on that order) and drops soft-deleted variants -- product_variants
 * has deleted_at, unlike product_images, and PostgREST embeds don't filter
 * soft-deleted rows on their own, so every caller that embeds variants
 * needs this same client-side pass (same convention as images.sort() below). */
function normalizeVariants<T extends { options: ProductOption[]; variants: (ProductVariant & { deleted_at: string | null })[] }>(product: T): T {
  return {
    ...product,
    options: [...product.options].sort((a, b) => a.display_order - b.display_order),
    variants: product.variants.filter((v) => !v.deleted_at),
  }
}

/** Builds the label shown wherever a variant needs to be picked/displayed
 * (OrderItemsEditor, StockMovementDrawer, the variants table itself) --
 * e.g. "Talla: M, Color: Azul". Skips axes the variant doesn't set (a
 * product can have fewer variants using an axis than options.length after
 * an option was added later). */
export function formatVariantLabel(variant: Pick<ProductVariant, 'option1_value' | 'option2_value' | 'option3_value'>, options: Pick<ProductOption, 'name'>[]): string {
  const values = [variant.option1_value, variant.option2_value, variant.option3_value]
  return options
    .map((option, i) => (values[i] ? `${option.name}: ${values[i]}` : null))
    .filter((part): part is string => !!part)
    .join(', ')
}

/** Product-cartesian of an product's option values, capped at 3 axes (UI
 * enforces the cap when defining options, this just consumes whatever it's
 * given). Returns the raw option1/2/3_value combinations -- the caller
 * (ProductVariantsCard's handleGenerate) is the one that decides which of
 * these are new vs. already exist as a variant. */
export function generateVariantCombinations(options: { name: string; values: string[] }[]): { option1_value: string | null; option2_value: string | null; option3_value: string | null }[] {
  const [a, b, c] = options
  const av = a?.values.length ? a.values : [null]
  const bv = b?.values.length ? b.values : [null]
  const cv = c?.values.length ? c.values : [null]

  const combos: { option1_value: string | null; option2_value: string | null; option3_value: string | null }[] = []
  for (const v1 of av) {
    for (const v2 of bv) {
      for (const v3 of cv) {
        if (v1 === null && v2 === null && v3 === null) continue
        combos.push({ option1_value: v1, option2_value: v2, option3_value: v3 })
      }
    }
  }
  return combos
}

// Both listProducts and getProduct embed categories through
// product_category_links (a product can be in several categories, see
// CLAUDE.md/product_category_links migration) -- PostgREST returns that as
// `categories: [{ category: {...} }]`, one wrapper level too deep to hand
// straight to the UI, so every caller unwraps it the same way.
function unwrapCategories<T extends { category: ProductCategoryRef | ProductCategoryRef[] | null }>(links: T[]): ProductCategoryRef[] {
  return links.map((l) => l.category).filter((c): c is ProductCategoryRef => !!c && !Array.isArray(c))
}

export interface ListProductsParams {
  page: number
  pageSize: number
  search?: string
  /** Already expanded to include descendants by the caller (see
   * descendantIds in productCategories.ts) -- selecting a parent category in
   * the tree filter should match every product filed under any of its
   * children too, not just that exact category. */
  categoryIds?: string[]
  brandId?: string | null
  /** Restricts to products with stock (quantity > 0) in this one warehouse --
   * "filtrar con stock de bodega" (Products.tsx). */
  warehouseId?: string | null
  /** Available (quantity - reserved, summed across every warehouse) at or
   * below the product's own low_stock_threshold. Needs two lean lookups
   * (see below) since neither the threshold nor the stock sum alone is
   * enough to decide this at the DB level without a view/RPC. */
  lowStockOnly?: boolean
}

export interface ListProductsResult {
  data: ProductWithImages[]
  count: number
}

/** Escapes the characters that have syntactic meaning inside a PostgREST
 * `.or()`/`.ilike()` filter string (`,` separates conditions, `(` `)` group
 * them, `%` `_` are ILIKE wildcards) so a search term containing any of
 * those can't corrupt the filter or turn into an unintended wildcard. */
function escapePostgrestPattern(term: string): string {
  return term.replace(/[,()%_]/g, '\\$&')
}

/** Server-side paginated + filtered product list (10 at a time by default,
 * see Products.tsx's PAGE_SIZE) -- replaces the old fetch-everything-then-
 * slice-client-side approach now that a tenant's catalog can run into the
 * hundreds. Category/warehouse/low-stock filters can't all be expressed as
 * a single embedded-relation PostgREST filter at once (product_category_links
 * and product_stock are two independent many-to-many/one-to-many joins), so
 * each one that's active first resolves to a plain product-id list, and
 * those lists are intersected client-side before the final `.in('id', ...)`
 * on the real query -- simpler and more robust than nested dot-path filters
 * on a doubly-embedded relation. */
export async function listProducts(tenantId: string, params: ListProductsParams): Promise<ListProductsResult> {
  const { page, pageSize, search, categoryIds, brandId, warehouseId, lowStockOnly } = params

  let idFilter: string[] | null = null
  function intersect(ids: string[]) {
    idFilter = idFilter ? idFilter.filter((id) => ids.includes(id)) : Array.from(new Set(ids))
  }

  if (categoryIds && categoryIds.length > 0) {
    const { data, error } = await supabase
      .from('product_category_links')
      .select('product_id')
      .eq('tenant_id', tenantId)
      .in('category_id', categoryIds)
    if (error) throw error
    intersect((data as { product_id: string }[]).map((r) => r.product_id))
  }

  if (warehouseId) {
    intersect(await listProductIdsWithWarehouseStock(tenantId, warehouseId))
  }

  if (lowStockOnly) {
    const [{ data: slim, error: slimError }, stockTotals] = await Promise.all([
      supabase.from('products').select('id, low_stock_threshold').eq('tenant_id', tenantId).eq('track_inventory', true).is('deleted_at', null),
      listStockTotalsByTenant(tenantId),
    ])
    if (slimError) throw slimError
    const lowStockIds = (slim as { id: string; low_stock_threshold: number }[])
      .filter((p) => (stockTotals.get(p.id)?.available ?? 0) <= p.low_stock_threshold)
      .map((p) => p.id)
    intersect(lowStockIds)
  }

  if (idFilter && (idFilter as string[]).length === 0) return { data: [], count: 0 }

  let query = supabase
    .from('products')
    .select(
      '*, images:product_images(*), categories:product_category_links(category:product_categories(id, name, parent_category_id)), supplier:suppliers(id, name), brand:brands(id, name), options:product_options(*), variants:product_variants(*)',
      { count: 'exact' },
    )
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)

  if (idFilter) query = query.in('id', idFilter)
  if (brandId) query = query.eq('brand_id', brandId)
  if (search && search.trim()) {
    const term = escapePostgrestPattern(search.trim())
    query = query.or(`name.ilike.%${term}%,sku.ilike.%${term}%`)
  }

  const from = (page - 1) * pageSize
  const to = from + pageSize - 1
  // Alphabetical by default -- was created_at desc (newest first), which
  // meant the list reordered itself every time a product got edited/added
  // and made a specific product hard to find by scanning (explicit user
  // complaint: "se desordenan... a veces no encuentro unos productos").
  const { data, error, count } = await query.order('name', { ascending: true }).range(from, to)
  if (error) throw error

  return {
    count: count ?? 0,
    data: (data as unknown as (ProductWithImages & { categories: { category: ProductCategoryRef }[] })[]).map((p) =>
      normalizeVariants({
        ...p,
        images: p.images.sort((a, b) => a.display_order - b.display_order),
        categories: unwrapCategories(p.categories),
      }),
    ),
  }
}

export type ProductDetail = Product & {
  images: ProductImage[]
  categories: ProductCategoryRef[]
  supplier: { id: string; name: string; contact_name: string | null; phone: string | null; email: string | null } | null
  brand: { id: string; name: string; logo_url: string | null } | null
  options: ProductOption[]
  variants: ProductVariant[]
}

/** Fuller join than listProducts (supplier contact details) --
 * ProductDetail.tsx shows more than the list/edit form does, so it needs
 * more than listProducts' lean shape. Returns null (not a throw) for "not
 * found", same convention as getClient -- the page decides how to render
 * that, not the API layer. */
export async function getProduct(id: string): Promise<ProductDetail | null> {
  const { data, error } = await supabase
    .from('products')
    .select(
      '*, images:product_images(*), categories:product_category_links(category:product_categories(id, name, parent_category_id)), supplier:suppliers(id, name, contact_name, phone, email), brand:brands(id, name, logo_url), options:product_options(*), variants:product_variants(*)',
    )
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle()
  if (error) throw error
  if (!data) return null
  const product = data as unknown as ProductDetail & { categories: { category: ProductCategoryRef }[] }
  return normalizeVariants({ ...product, images: product.images.sort((a, b) => a.display_order - b.display_order), categories: unwrapCategories(product.categories) })
}

/** Replaces the product's entire category assignment (delete-then-reinsert,
 * not a diff) -- same trade-off already made for sales_order_items in
 * lib/api/orders.ts: a form always edits the full set at once, so
 * reconciling adds/removes line by line isn't worth it. `product_category_links`
 * has no soft-delete of its own (see CLAUDE.md's puente-sin-identidad
 * exception, same as conversation_tag_assignments), so a real DELETE here is
 * correct, not a shortcut. */
async function saveProductCategories(tenantId: string, productId: string, categoryIds: string[]): Promise<void> {
  const { error: deleteError } = await supabase.from('product_category_links').delete().eq('product_id', productId)
  if (deleteError) throw deleteError
  if (categoryIds.length === 0) return

  const rows = categoryIds.map((categoryId) => ({ tenant_id: tenantId, product_id: productId, category_id: categoryId }))
  const { error: insertError } = await supabase.from('product_category_links').insert(rows)
  if (insertError) throw insertError
}

export interface ProductOptionInput {
  name: string
  display_order: number
  values: string[]
}

/** Replaces the product's option axes wholesale (delete-then-reinsert) --
 * unlike variants below, product_options has no FKs pointing at it
 * (product_variants stores value snapshots as text, not option ids), so
 * there's nothing to lose by recreating every row on each save -- same
 * trade-off as saveProductCategories. */
export async function saveProductOptions(tenantId: string, productId: string, options: ProductOptionInput[]): Promise<void> {
  const { error: deleteError } = await supabase.from('product_options').delete().eq('product_id', productId)
  if (deleteError) throw deleteError
  if (options.length === 0) return

  const rows = options.map((o) => ({ tenant_id: tenantId, product_id: productId, name: o.name, display_order: o.display_order, values: o.values }))
  const { error: insertError } = await supabase.from('product_options').insert(rows)
  if (insertError) throw insertError
}

export interface ProductVariantInput {
  sku: string | null
  option1_value: string | null
  option2_value: string | null
  option3_value: string | null
  purchase_price: number | null
  wholesale_price: number | null
  retail_price: number | null
  is_active: boolean
}

/** Variants persist one row at a time (create/update/delete), not as a
 * batch form submit -- ProductVariantsCard (ProductDetail.tsx) needs each
 * variant's real id right after creating it so a photo can be attached to
 * it immediately (product_images.variant_id needs a real row to point at,
 * same constraint uploadProductImage already has for the product itself),
 * and every other field on this page (is_active, images) already saves
 * per-action instead of through one big "Guardar" button. */
export async function createProductVariant(tenantId: string, productId: string, input: ProductVariantInput): Promise<ProductVariant> {
  const { data, error } = await supabase
    .from('product_variants')
    .insert({ tenant_id: tenantId, product_id: productId, ...input })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function updateProductVariant(id: string, patch: Partial<ProductVariantInput>): Promise<ProductVariant> {
  const { data, error } = await supabase.from('product_variants').update(patch).eq('id', id).select().single()
  if (error) throw error
  return data
}

export async function deleteProductVariant(id: string): Promise<void> {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const { error } = await supabase.from('product_variants').update({ deleted_at: new Date().toISOString(), deleted_by: user?.id ?? null }).eq('id', id)
  if (error) throw error
}

export async function createProduct(input: ProductInput, categoryIds: string[] = []): Promise<Product> {
  const { data, error } = await supabase.from('products').insert(input).select().single()
  if (error) throw error
  await saveProductCategories(input.tenant_id, data.id, categoryIds)
  return data
}

export async function updateProduct(id: string, input: Partial<ProductInput>, categoryIds?: string[]): Promise<Product> {
  const { data, error } = await supabase.from('products').update(input).eq('id', id).select().single()
  if (error) throw error
  // categoryIds is optional here (unlike createProduct) so a caller that
  // only patches unrelated fields (e.g. a stock adjustment elsewhere) never
  // has to know/resend the current category list just to avoid wiping it.
  if (categoryIds !== undefined) await saveProductCategories(data.tenant_id, id, categoryIds)
  return data
}

export async function deleteProduct(id: string): Promise<void> {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const { error } = await supabase.from('products').update({ deleted_at: new Date().toISOString(), deleted_by: user?.id ?? null }).eq('id', id)
  if (error) throw error
}

const PRODUCT_IMAGE_ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp']
const PRODUCT_IMAGE_MAX_BYTES = 5 * 1024 * 1024
// Standard resolution every product photo gets normalized to before upload --
// a catalog photo doesn't need more than this to look sharp in a list/drawer/
// WhatsApp message, and capping it here is what actually saves storage
// (rejecting oversized files only stops a 20MB phone photo from being
// uploaded raw, it doesn't shrink a merely-large one).
const PRODUCT_IMAGE_MAX_DIMENSION = 1200
const PRODUCT_IMAGE_QUALITY = 0.82

/** Returns a translation key (not a display string) -- same convention as
 * validatePqrAttachmentFile/validateTaskAttachmentFile in lib/api/attachments.ts,
 * the caller runs it through t() before showing it. */
export function validateProductImageFile(file: File): TranslationKey | null {
  if (!PRODUCT_IMAGE_ALLOWED_TYPES.includes(file.type)) return 'common.attachment.error.invalidImageType'
  if (file.size > PRODUCT_IMAGE_MAX_BYTES) return 'products.drawer.images.tooLarge'
  return null
}

/** Downscales to at most PRODUCT_IMAGE_MAX_DIMENSION px on the longest side
 * and re-encodes as WebP -- run client-side, before the file ever reaches
 * Storage, so a phone photo (often 3-4MB) typically uploads as a few
 * hundred KB instead. Falls back to the original file untouched if the
 * browser can't decode/encode it (very old browser, or a corrupt file) --
 * upload still proceeds, it just skips the optimization. */
async function resizeImageForUpload(file: File): Promise<{ blob: Blob; ext: string }> {
  try {
    const bitmap = await createImageBitmap(file)
    let { width, height } = bitmap
    if (width > PRODUCT_IMAGE_MAX_DIMENSION || height > PRODUCT_IMAGE_MAX_DIMENSION) {
      const scale = PRODUCT_IMAGE_MAX_DIMENSION / Math.max(width, height)
      width = Math.round(width * scale)
      height = Math.round(height * scale)
    }

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return { blob: file, ext: file.name.split('.').pop()?.toLowerCase() || 'jpg' }
    ctx.drawImage(bitmap, 0, 0, width, height)

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', PRODUCT_IMAGE_QUALITY))
    if (!blob) return { blob: file, ext: file.name.split('.').pop()?.toLowerCase() || 'jpg' }
    return { blob, ext: 'webp' }
  } catch {
    return { blob: file, ext: file.name.split('.').pop()?.toLowerCase() || 'jpg' }
  }
}

/** Uploads to `product-images/{tenantId}/{productId}/{timestamp}.{ext}` and
 * inserts the product_images row that points at it -- the storage upload
 * and the DB row are two separate steps, unlike the tenant logo's single
 * upsert-by-fixed-path, because a product can have several images. */
export async function uploadProductImage(tenantId: string, productId: string, file: File, displayOrder: number, variantId: string | null = null): Promise<ProductImage> {
  const validationError = validateProductImageFile(file)
  if (validationError) throw new Error(validationError)

  const { blob, ext } = await resizeImageForUpload(file)
  const path = `${tenantId}/${productId}/${Date.now()}.${ext}`

  const { error: uploadError } = await supabase.storage.from('product-images').upload(path, blob, { contentType: blob.type || file.type })
  if (uploadError) throw uploadError

  const { data, error } = await supabase
    .from('product_images')
    .insert({ tenant_id: tenantId, product_id: productId, storage_path: path, display_order: displayOrder, variant_id: variantId })
    .select()
    .single()
  if (error) throw error
  return data
}

export function getProductImageUrl(storagePath: string): string {
  return supabase.storage.from('product-images').getPublicUrl(storagePath).data.publicUrl
}

export async function deleteProductImage(id: string, storagePath: string): Promise<void> {
  const { error } = await supabase.from('product_images').delete().eq('id', id)
  if (error) throw error
  // Best-effort: an orphaned storage object is harmless (never linked/shown
  // again), so a failure here shouldn't surface as an error to the user.
  await supabase.storage.from('product-images').remove([storagePath])
}
