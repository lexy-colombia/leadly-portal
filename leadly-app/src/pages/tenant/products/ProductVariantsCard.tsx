import { useEffect, useRef, useState } from 'react'
import {
  createProductVariant,
  deleteProductImage,
  deleteProductVariant,
  formatVariantLabel,
  generateVariantCombinations,
  getProductImageUrl,
  saveProductOptions,
  updateProduct,
  updateProductVariant,
  uploadProductImage,
  validateProductImageFile,
} from '../../../lib/api/products'
import type { ProductDetail, ProductOptionInput, ProductVariantInput } from '../../../lib/api/products'
import { listStockTotalsByVariant } from '../../../lib/api/stockMovements'
import type { ProductStockTotal } from '../../../lib/api/stockMovements'
import type { ProductVariant } from '../../../types/domain'
import { useLanguage } from '../../../contexts/LanguageContext'
import { PlusIcon, TrashIcon } from '@/components/atoms/icons'
import { CurrencyInput, TagInput } from '@/components/molecules'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'

const MAX_OPTIONS = 3
// Same compact convention as ProductDrawer/StockMovementDrawer -- one thin
// row per variant instead of a full-height card, so a product with a dozen
// variants doesn't turn this section into an endless scroll.
const ROW_FIELD_CLASS = '!h-7 !rounded-lg !text-xs'

function formatCurrency(value: number | null, currency: string): string {
  if (value == null) return '—'
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value)
}

type Combo = { option1_value: string | null; option2_value: string | null; option3_value: string | null }

/** Combination-key comparison, ignoring which of the 3 axes a value sits in
 * relative to nulls -- matches the DB's own coalesce(...,'') unique index
 * (see 20260819060000_product_options_and_variants.sql) so "already exists"
 * checks here agree with what the database would actually reject. */
function comboKey(v: Combo): string {
  const parts = [v.option1_value ?? '', v.option2_value ?? '', v.option3_value ?? '']
  return parts.join('|')
}

/** "M-AZUL" from {option1_value:"M", option2_value:"Azul"} -- the bit that
 * differentiates one generated SKU from another. Explicit user request:
 * a generated variant's SKU shouldn't just silently inherit the parent's
 * (leaving every variant indistinguishable by SKU) -- it needs its own,
 * built from the combination that makes it unique in the first place. */
function skuSuffix(combo: Combo): string {
  const parts = [combo.option1_value, combo.option2_value, combo.option3_value].filter((v): v is string => !!v)
  return parts.map((v) => v.trim().toUpperCase().replace(/\s+/g, '')).join('-')
}

/** Mini photo strip scoped to one variant -- same upload/remove mechanics
 * as ProductDrawer's ProductImages, just filtered to this variant's own
 * images (product_images.variant_id) instead of the product's general
 * gallery, and always available (never gated on the product needing to be
 * saved first -- a variant only exists here once it already has a real id).
 * Sized small (h-8) and non-wrapping -- lives inline inside VariantRow's
 * single scrolling line, not a standalone block, so the thumbnails need to
 * stay actually visible there instead of tucked behind a click (explicit
 * user request) without blowing up the row's height. */
function VariantImages({ tenantId, product, variant, images, onChanged }: { tenantId: string; product: ProductDetail; variant: ProductVariant; images: ProductDetail['images']; onChanged: () => void }) {
  const { t } = useLanguage()
  const inputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null
    e.target.value = ''
    if (!file) return
    const validationError = validateProductImageFile(file)
    if (validationError) {
      setError(t(validationError))
      return
    }
    setError(null)
    setUploading(true)
    try {
      await uploadProductImage(tenantId, product.id, file, images.length, variant.id)
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('products.drawer.images.uploadError'))
    } finally {
      setUploading(false)
    }
  }

  async function handleRemove(imageId: string, storagePath: string) {
    try {
      await deleteProductImage(imageId, storagePath)
      onChanged()
    } catch {
      setError(t('products.drawer.images.removeError'))
    }
  }

  return (
    <div className="relative flex shrink-0 items-center gap-1">
      {error && <span className="absolute -top-5 left-0 z-10 rounded bg-red-50 px-1.5 py-0.5 text-[10px] whitespace-nowrap text-red-600">{error}</span>}
      <div className="flex shrink-0 items-center gap-1">
        {images.map((img) => (
          <div key={img.id} className="group relative h-8 w-8 shrink-0 overflow-hidden rounded-md border border-brand-100">
            <img src={getProductImageUrl(img.storage_path)} alt="" className="h-full w-full object-cover" />
            <button
              type="button"
              onClick={() => handleRemove(img.id, img.storage_path)}
              className="absolute inset-0 flex items-center justify-center bg-black/50 text-white opacity-0 transition-opacity group-hover:opacity-100"
              aria-label={t('products.drawer.images.removeAria')}
            >
              <TrashIcon width={11} height={11} />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-dashed border-brand-300 text-brand-400 hover:border-accent-400 hover:text-accent-500"
        >
          <PlusIcon width={13} height={13} />
        </button>
      </div>
      <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={handleSelect} />
    </div>
  )
}

/** One variant, one thin row -- combination, SKU, the 3 prices, stock,
 * photo thumbnails (small but actually visible, not hidden behind a click)
 * and active/delete all on a single line (explicit user request: the
 * previous stacked-card version "se ve feo", took too much vertical space
 * for what is essentially a table). Every field still autosaves on
 * blur/toggle, no per-row "Guardar" button. `overflow-x-auto` on the
 * container lets the row scroll horizontally on narrow screens instead of
 * wrapping, since wrapping would defeat "single line" on mobile too. */
function VariantRow({
  tenantId,
  product,
  variant,
  options,
  stock,
  onChanged,
}: {
  tenantId: string
  product: ProductDetail
  variant: ProductVariant
  options: ProductOptionInput[]
  stock: ProductStockTotal | undefined
  onChanged: () => void
}) {
  const { t } = useLanguage()
  const [sku, setSku] = useState(variant.sku ?? '')
  const [purchasePrice, setPurchasePrice] = useState(variant.purchase_price != null ? String(variant.purchase_price) : '')
  const [wholesalePrice, setWholesalePrice] = useState(variant.wholesale_price != null ? String(variant.wholesale_price) : '')
  const [retailPrice, setRetailPrice] = useState(variant.retail_price != null ? String(variant.retail_price) : '')

  useEffect(() => {
    setSku(variant.sku ?? '')
    setPurchasePrice(variant.purchase_price != null ? String(variant.purchase_price) : '')
    setWholesalePrice(variant.wholesale_price != null ? String(variant.wholesale_price) : '')
    setRetailPrice(variant.retail_price != null ? String(variant.retail_price) : '')
  }, [variant.id, variant.sku, variant.purchase_price, variant.wholesale_price, variant.retail_price])

  async function save(patch: Partial<ProductVariantInput>) {
    await updateProductVariant(variant.id, patch)
    onChanged()
  }

  async function handleDelete() {
    await deleteProductVariant(variant.id)
    onChanged()
  }

  const variantImages = product.images.filter((img) => img.variant_id === variant.id)

  return (
    <div className="flex items-center justify-between gap-3 overflow-x-auto px-3 py-2">
      <span className="w-28 shrink-0 truncate text-xs font-medium text-brand-800" title={formatVariantLabel(variant, options)}>
        {formatVariantLabel(variant, options)}
      </span>
      <Input
        value={sku}
        onChange={(e) => setSku(e.target.value)}
        onBlur={() => save({ sku: sku.trim() || null })}
        placeholder={t('products.drawer.variants.skuPlaceholder', { sku: product.sku || '—' })}
        className={`w-28 shrink-0 ${ROW_FIELD_CLASS}`}
      />
      <CurrencyInput
        value={purchasePrice}
        onChange={(e) => setPurchasePrice(e.target.value)}
        onBlur={() => save({ purchase_price: purchasePrice ? Number(purchasePrice) : null })}
        placeholder={formatCurrency(product.purchase_price, product.currency)}
        className={`w-24 shrink-0 ${ROW_FIELD_CLASS}`}
      />
      <CurrencyInput
        value={wholesalePrice}
        onChange={(e) => setWholesalePrice(e.target.value)}
        onBlur={() => save({ wholesale_price: wholesalePrice ? Number(wholesalePrice) : null })}
        placeholder={formatCurrency(product.wholesale_price, product.currency)}
        className={`w-24 shrink-0 ${ROW_FIELD_CLASS}`}
      />
      <CurrencyInput
        value={retailPrice}
        onChange={(e) => setRetailPrice(e.target.value)}
        onBlur={() => save({ retail_price: retailPrice ? Number(retailPrice) : null })}
        placeholder={formatCurrency(product.retail_price, product.currency)}
        className={`w-24 shrink-0 ${ROW_FIELD_CLASS}`}
      />
      <span className="w-16 shrink-0 text-xs text-brand-400">{stock ? stock.available : 0} disp.</span>

      <VariantImages tenantId={tenantId} product={product} variant={variant} images={variantImages} onChanged={onChanged} />

      {/* Switch+delete grouped in their own flex item -- justify-between on
          the row spreads every item evenly across the full width (the
          actual ask: on a wide screen the fields were all bunched at the
          left with a big dead gap before these two), but without this
          wrapper the group itself would also get spread apart from each
          other by the same even-gap logic, undoing "activo pegado al
          eliminar" from the previous round. */}
      <div className="flex shrink-0 items-center gap-2">
        <Switch checked={variant.is_active} onCheckedChange={(checked) => save({ is_active: checked })} />
        <Button type="button" variant="ghost" onClick={handleDelete} aria-label={t('products.drawer.variants.removeVariantAria')} className="!h-7 !shrink-0 !px-2 !text-red-600 hover:!bg-red-50">
          <TrashIcon width={13} height={13} />
        </Button>
      </div>
    </div>
  )
}

/** Lives on ProductDetail (not ProductDrawer) on purpose -- explicit user
 * feedback: the compact drawer form had no room for this (options, a
 * growing list of variant cards, each with its own photo strip), and
 * variants are closer in spirit to the page's other live-editing sections
 * (stock, images) than to the one-shot "edit basic fields" form. */
export function ProductVariantsCard({
  tenantId,
  product,
  hasExistingStock,
  onChanged,
}: {
  tenantId: string
  product: ProductDetail
  /** True if this product already has stock recorded at the parent level
   * (product_stock rows with variant_id null) -- only meaningful while
   * has_variants is still false, computed by ProductDetail from the same
   * stockByWarehouse it already loads. Blocks turning variants on: once a
   * product uses variants, ITS stock has to be the sum of the variants',
   * never a separate number sitting on the parent (explicit user request) --
   * so any stock already on the parent has to be brought to zero (via a
   * normal adjustment) before variants can be enabled. */
  hasExistingStock: boolean
  onChanged: () => void
}) {
  const { t } = useLanguage()
  const [optionsDraft, setOptionsDraft] = useState<ProductOptionInput[]>([])
  const [stockTotals, setStockTotals] = useState<Map<string, ProductStockTotal>>(new Map())
  const [savingOptions, setSavingOptions] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Deliberately only re-hydrates on product.id, not on every product.options
  // change: onChanged() triggers a full reload from *any* action on this
  // page (toggling a variant's "Activo", uploading a photo, etc.), and
  // re-syncing the draft from the server on every one of those would wipe
  // an option name/value the user is still mid-typing but hasn't saved
  // yet. The only writer of product_options is this component itself
  // (handleSaveOptions/handleGenerate), so the draft is already correct
  // right after either of those -- nothing else can change it server-side.
  useEffect(() => {
    setOptionsDraft(product.options.map((o) => ({ name: o.name, display_order: o.display_order, values: o.values })))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product.id])

  useEffect(() => {
    listStockTotalsByVariant(product.id).then(setStockTotals).catch(() => {})
  }, [product.id, product.variants.length])

  function updateOption(index: number, patch: Partial<ProductOptionInput>) {
    setOptionsDraft(optionsDraft.map((o, i) => (i === index ? { ...o, ...patch } : o)))
  }

  function addOption() {
    if (optionsDraft.length >= MAX_OPTIONS) return
    setOptionsDraft([...optionsDraft, { name: '', display_order: optionsDraft.length, values: [] }])
  }

  function removeOption(index: number) {
    setOptionsDraft(optionsDraft.filter((_, i) => i !== index).map((o, i) => ({ ...o, display_order: i })))
  }

  async function handleToggle(next: boolean) {
    if (!next && product.variants.length > 0) return
    if (next && hasExistingStock) {
      setError(t('products.detail.variants.errors.existingStockBlocksEnable'))
      return
    }
    setError(null)
    try {
      await updateProduct(product.id, { has_variants: next })
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('products.drawer.errors.save'))
    }
  }

  async function handleSaveOptions() {
    setError(null)
    if (optionsDraft.some((o) => !o.name.trim())) {
      setError(t('products.drawer.variants.errors.optionNameRequired'))
      return
    }
    if (optionsDraft.some((o) => o.values.length === 0)) {
      setError(t('products.drawer.variants.errors.optionValuesRequired'))
      return
    }
    setSavingOptions(true)
    try {
      await saveProductOptions(tenantId, product.id, optionsDraft)
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('products.drawer.errors.save'))
    } finally {
      setSavingOptions(false)
    }
  }

  async function handleGenerate() {
    setError(null)
    if (optionsDraft.some((o) => !o.name.trim())) {
      setError(t('products.drawer.variants.errors.optionNameRequired'))
      return
    }
    if (optionsDraft.some((o) => o.values.length === 0)) {
      setError(t('products.drawer.variants.errors.optionValuesRequired'))
      return
    }
    setGenerating(true)
    try {
      // Keeps product_options in sync with whatever produced these variants
      // -- generating from an unsaved options draft would otherwise leave
      // real, persisted variants whose axis definition only exists in this
      // component's local state.
      await saveProductOptions(tenantId, product.id, optionsDraft)
      const existing = new Set(product.variants.map(comboKey))
      const missing = generateVariantCombinations(optionsDraft).filter((c) => !existing.has(comboKey(c)))
      for (const combo of missing) {
        // SKU and prices are pre-filled (not left null/inherited) --
        // explicit user request: a generated variant should start from the
        // parent's own price and a SKU that's actually distinguishable from
        // its siblings, editable per-variant from there if it needs to
        // differ (e.g. a bigger size costing more).
        const suffix = skuSuffix(combo)
        await createProductVariant(tenantId, product.id, {
          ...combo,
          sku: product.sku ? `${product.sku}-${suffix}` : suffix || null,
          purchase_price: product.purchase_price,
          wholesale_price: product.wholesale_price,
          retail_price: product.retail_price,
          is_active: true,
        })
      }
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('products.drawer.errors.save'))
    } finally {
      setGenerating(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between rounded-lg border border-brand-100 px-4 py-3">
        <div>
          <p className="text-sm font-medium text-brand-700">{t('products.drawer.variants.enable')}</p>
          <p className="mt-0.5 text-xs text-brand-400">{t('products.drawer.variants.enableHint')}</p>
        </div>
        <Switch checked={product.has_variants} onCheckedChange={handleToggle} disabled={!product.has_variants && hasExistingStock} />
      </div>
      {product.has_variants && product.variants.length > 0 && <p className="text-xs text-brand-400">{t('products.drawer.variants.disableBlocked')}</p>}
      {!product.has_variants && hasExistingStock && <p className="text-xs text-amber-600">{t('products.detail.variants.errors.existingStockBlocksEnable')}</p>}

      {product.has_variants && (
        <>
          <div className="space-y-3">
            {optionsDraft.map((option, index) => (
              <div key={index} className="flex flex-col gap-3 rounded-lg border border-brand-100 p-3 sm:flex-row sm:items-start">
                <div className="w-full sm:w-40">
                  <Label className="text-xs">{t('products.detail.variants.optionName')}</Label>
                  <Input value={option.name} onChange={(e) => updateOption(index, { name: e.target.value })} placeholder={t('products.drawer.variants.optionNamePlaceholder')} className="mt-1" />
                </div>
                <div className="min-w-0 flex-1">
                  <Label className="text-xs">{t('products.detail.variants.optionValues')}</Label>
                  <div className="mt-1">
                    <TagInput value={option.values} onChange={(values) => updateOption(index, { values })} placeholder={t('products.drawer.variants.optionValuesPlaceholder')} />
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => removeOption(index)}
                  aria-label={t('products.drawer.variants.removeOptionAria')}
                  className="!self-end !px-2 !py-1.5 !text-red-600 hover:!bg-red-50 sm:!self-start"
                >
                  <TrashIcon width={14} height={14} />
                </Button>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={addOption} disabled={optionsDraft.length >= MAX_OPTIONS}>
              <PlusIcon width={13} height={13} /> {t('products.drawer.variants.addOption')}
            </Button>
            {optionsDraft.length > 0 && (
              <Button type="button" size="sm" onClick={handleSaveOptions} disabled={savingOptions}>
                {savingOptions ? t('common.actions.saving') : t('products.detail.variants.saveOptions')}
              </Button>
            )}
            {optionsDraft.length > 0 && (
              <Button type="button" variant="secondary" size="sm" onClick={handleGenerate} disabled={generating}>
                {generating ? t('common.actions.saving') : t('products.drawer.variants.generate')}
              </Button>
            )}
            {optionsDraft.length >= MAX_OPTIONS && <span className="text-xs text-brand-400">{t('products.drawer.variants.maxOptionsReached')}</span>}
          </div>
          {optionsDraft.length > 0 && <p className="text-xs text-brand-400">{t('products.drawer.variants.generateHint')}</p>}

          {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

          {product.variants.length > 0 ? (
            <div className="divide-y divide-brand-100 rounded-lg border border-brand-100">
              {product.variants.map((variant) => (
                <VariantRow key={variant.id} tenantId={tenantId} product={product} variant={variant} options={optionsDraft} stock={stockTotals.get(variant.id)} onChanged={onChanged} />
              ))}
            </div>
          ) : (
            optionsDraft.length > 0 && <p className="text-sm text-brand-400">{t('products.drawer.variants.empty')}</p>
          )}
        </>
      )}
    </div>
  )
}
