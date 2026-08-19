import { supabase } from '../supabaseClient'
import type { Brand } from '../../types/domain'
import type { TranslationKey } from '../../i18n/translations'
import { BRAND_LOGO_ALLOWED_TYPES, BRAND_LOGO_MAX_BYTES } from '../referenceData'

export interface BrandInput {
  /** Only ever set by createBrand's caller (BrandDrawer), never by
   * updateBrand -- lets the logo's storage path (keyed by id) be known and
   * uploadable before the row exists, since the client generates this same
   * id upfront instead of waiting for Postgres's default. */
  id?: string
  tenant_id: string
  name: string
  logo_url?: string | null
  is_active?: boolean
}

export async function listBrands(tenantId: string): Promise<Brand[]> {
  const { data, error } = await supabase
    .from('brands')
    .select('*')
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .order('name', { ascending: true })
  if (error) throw error
  return data
}

export async function createBrand(input: BrandInput): Promise<Brand> {
  const { data, error } = await supabase.from('brands').insert(input).select().single()
  if (error) throw error
  return data
}

export async function updateBrand(id: string, input: Partial<BrandInput>): Promise<Brand> {
  const { data, error } = await supabase.from('brands').update(input).eq('id', id).select().single()
  if (error) throw error
  return data
}

export async function deleteBrand(id: string): Promise<void> {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const { error } = await supabase.from('brands').update({ deleted_at: new Date().toISOString(), deleted_by: user?.id ?? null }).eq('id', id)
  if (error) throw error
}

/** Returns a translation key (not a display string), same convention as
 * validateProductImageFile -- the caller runs it through t() before showing it. */
export function validateBrandLogoFile(file: File): TranslationKey | null {
  if (!BRAND_LOGO_ALLOWED_TYPES.includes(file.type)) return 'common.attachment.error.invalidImageType'
  if (file.size > BRAND_LOGO_MAX_BYTES) return 'products.brands.logo.errors.tooLarge'
  return null
}

/** Uploads to `product-images/{tenantId}/brands/{brandId}.{ext}` (upsert, so
 * re-uploading replaces the old file at the same path) and returns the
 * resulting public URL. Storage-only, no DB write -- BrandDrawer persists
 * `logo_url` itself together with the rest of the form (name/is_active) on
 * submit, so a picked logo isn't "saved" as a side effect of uploading, same
 * as every other field. `brandId` is either a saved brand's real id, or the
 * client-generated uuid BrandDrawer passes as the future id of a brand
 * that's still being created (see BrandInput.id) -- either way it's the id
 * the row ends up with, so the storage path and the row's real id never
 * diverge, unlike a temp-path-then-move scheme would need. */
export async function uploadBrandLogo(tenantId: string, brandId: string, file: File): Promise<string> {
  const validationError = validateBrandLogoFile(file)
  if (validationError) throw new Error(validationError)

  const ext = file.name.split('.').pop()?.toLowerCase() || 'png'
  const path = `${tenantId}/brands/${brandId}.${ext}`

  const { error: uploadError } = await supabase.storage.from('product-images').upload(path, file, {
    upsert: true,
    contentType: file.type,
  })
  if (uploadError) throw uploadError

  const { data: publicUrlData } = supabase.storage.from('product-images').getPublicUrl(path)
  // Cache-bust so the new logo shows immediately instead of the browser reusing
  // a cached response for the same path after an upsert.
  return `${publicUrlData.publicUrl}?v=${Date.now()}`
}

/** Best-effort storage cleanup, no DB write -- same reasoning as
 * deleteProductImage: an orphaned object (e.g. the user picked a logo then
 * canceled the drawer without saving) is harmless, never linked or shown
 * anywhere, so a failure here shouldn't surface as an error to the user. */
export async function removeBrandLogo(tenantId: string, brandId: string): Promise<void> {
  const exts = ['png', 'jpg', 'jpeg', 'webp']
  await supabase.storage.from('product-images').remove(exts.map((e) => `${tenantId}/brands/${brandId}.${e}`))
}
