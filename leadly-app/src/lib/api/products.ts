import { supabase } from '../supabaseClient'
import type { Product, ProductImage } from '../../types/domain'
import type { TranslationKey } from '../../i18n/translations'

export interface ProductInput {
  tenant_id: string
  name: string
  description?: string | null
  sku?: string | null
  slug?: string | null
  category_id?: string | null
  supplier_id?: string | null
  brand_id?: string | null
  purchase_price?: number | null
  wholesale_price?: number | null
  retail_price?: number | null
  currency?: string
  track_inventory?: boolean
  low_stock_threshold?: number
  is_active?: boolean
}

export type ProductWithImages = Product & {
  images: ProductImage[]
  category: { id: string; name: string; color: string | null } | null
  supplier: { id: string; name: string } | null
  brand: { id: string; name: string } | null
}

export async function listProducts(tenantId: string): Promise<ProductWithImages[]> {
  const { data, error } = await supabase
    .from('products')
    .select('*, images:product_images(*), category:product_categories(id, name, color), supplier:suppliers(id, name), brand:brands(id, name)')
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
  if (error) throw error
  return (data as unknown as ProductWithImages[]).map((p) => ({ ...p, images: p.images.sort((a, b) => a.display_order - b.display_order) }))
}

export type ProductDetail = Product & {
  images: ProductImage[]
  category: { id: string; name: string; color: string | null; description: string | null } | null
  supplier: { id: string; name: string; contact_name: string | null; phone: string | null; email: string | null } | null
  brand: { id: string; name: string } | null
}

/** Fuller join than listProducts (category description, supplier contact
 * details) -- ProductDetail.tsx shows more than the list/edit form does,
 * so it needs more than listProducts' lean shape. Returns null (not a
 * throw) for "not found", same convention as getContact -- the page decides
 * how to render that, not the API layer. */
export async function getProduct(id: string): Promise<ProductDetail | null> {
  const { data, error } = await supabase
    .from('products')
    .select(
      '*, images:product_images(*), category:product_categories(id, name, color, description), supplier:suppliers(id, name, contact_name, phone, email), brand:brands(id, name)',
    )
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle()
  if (error) throw error
  if (!data) return null
  const product = data as unknown as ProductDetail
  return { ...product, images: product.images.sort((a, b) => a.display_order - b.display_order) }
}

export async function createProduct(input: ProductInput): Promise<Product> {
  const { data, error } = await supabase.from('products').insert(input).select().single()
  if (error) throw error
  return data
}

export async function updateProduct(id: string, input: Partial<ProductInput>): Promise<Product> {
  const { data, error } = await supabase.from('products').update(input).eq('id', id).select().single()
  if (error) throw error
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
export async function uploadProductImage(tenantId: string, productId: string, file: File, displayOrder: number): Promise<ProductImage> {
  const validationError = validateProductImageFile(file)
  if (validationError) throw new Error(validationError)

  const { blob, ext } = await resizeImageForUpload(file)
  const path = `${tenantId}/${productId}/${Date.now()}.${ext}`

  const { error: uploadError } = await supabase.storage.from('product-images').upload(path, blob, { contentType: blob.type || file.type })
  if (uploadError) throw uploadError

  const { data, error } = await supabase
    .from('product_images')
    .insert({ tenant_id: tenantId, product_id: productId, storage_path: path, display_order: displayOrder })
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
