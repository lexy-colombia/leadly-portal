import { useEffect, useState } from 'react'
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
import { ImageGalleryField } from '@/components/molecules/ImageGalleryField'
import { Pagination } from '@/components/molecules/Pagination'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Switch } from '@/components/ui/switch'

const MAX_OPTIONS = 3
const ROW_FIELD_CLASS = '!h-6 !min-w-0 !w-full rounded-md px-2 text-xs'

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

/** Variant photos reuse the same gallery field as the product editor. */
function VariantImages({ tenantId, product, variant, images, onChanged }: { tenantId: string; product: ProductDetail; variant: ProductVariant; images: ProductDetail['images']; onChanged: () => void }) {
  const { t } = useLanguage()
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSelect(files: File[]) {
    if (!files.length) return
    const file = files[0]
    const validationError = validateProductImageFile(file)
    if (validationError) {
      setError(t(validationError))
      return
    }
    setError(null)
    setUploading(true)
    try {
      for (const [index, image] of files.entries()) {
        const validation = validateProductImageFile(image)
        if (validation) throw new Error(t(validation))
        await uploadProductImage(tenantId, product.id, image, images.length + index, variant.id)
      }
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

  return <div className="mt-2">
    <ImageGalleryField compact label={t('products.drawer.images.label')} addLabel={t('products.drawer.images.add')} removeLabel={t('products.drawer.images.removeAria')} busy={uploading}
      images={images.map((image) => ({ id: image.id, src: getProductImageUrl(image.storage_path) }))}
      onAdd={handleSelect} onRemove={(id) => { const image = images.find((item) => item.id === id); if (image) void handleRemove(id, image.storage_path) }} />
    {error && <p role="alert" className="mt-1 text-xs text-destructive">{error}</p>}
  </div>
}

/** Inline edits preserve inherited prices and save only changed fields. */
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
  const [rowError, setRowError] = useState<string | null>(null)
  const [sku, setSku] = useState(variant.sku ?? '')
  const [barcode, setBarcode] = useState(variant.barcode ?? '')
  const [purchasePrice, setPurchasePrice] = useState(variant.purchase_price != null ? String(variant.purchase_price) : '')
  const [wholesalePrice, setWholesalePrice] = useState(variant.wholesale_price != null ? String(variant.wholesale_price) : '')
  const [retailPrice, setRetailPrice] = useState(variant.retail_price != null ? String(variant.retail_price) : '')

  useEffect(() => {
    setSku(variant.sku ?? '')
    setBarcode(variant.barcode ?? '')
    setPurchasePrice(variant.purchase_price != null ? String(variant.purchase_price) : '')
    setWholesalePrice(variant.wholesale_price != null ? String(variant.wholesale_price) : '')
    setRetailPrice(variant.retail_price != null ? String(variant.retail_price) : '')
  }, [variant.id, variant.sku, variant.barcode, variant.purchase_price, variant.wholesale_price, variant.retail_price])

  async function save(patch: Partial<ProductVariantInput>) {
    if (Object.entries(patch).every(([key, value]) => variant[key as keyof ProductVariant] === value)) return
    setRowError(null)
    try { await updateProductVariant(variant.id, patch); onChanged() }
    catch (err) { setRowError(err instanceof Error ? err.message : t('products.drawer.errors.save')) }
  }

  async function handleDelete() {
    try { await deleteProductVariant(variant.id); onChanged() }
    catch (err) { setRowError(err instanceof Error ? err.message : t('products.drawer.errors.save')) }
  }

  const variantImages = product.images.filter((img) => img.variant_id === variant.id)

  const label = formatVariantLabel(variant, options)
  return <TableRow className="align-top [&_td]:py-1.5">
    <TableCell className="p-2 text-xs font-medium">
      {label}
      <VariantImages tenantId={tenantId} product={product} variant={variant} images={variantImages} onChanged={onChanged} />
      {rowError && <p role="alert" className="mt-1 text-xs text-destructive">{rowError}</p>}
    </TableCell>
    <TableCell className="p-2"><div className="flex min-w-0 flex-col gap-1">
      <Input aria-label={`SKU · ${label}`} value={sku} onChange={(e) => setSku(e.target.value)} onBlur={() => save({ sku: sku.trim() || null })} placeholder={product.sku ?? 'SKU'} className={ROW_FIELD_CLASS} />
      <Input aria-label={`${t('products.detail.fields.barcode')} · ${label}`} value={barcode} onChange={(e) => setBarcode(e.target.value)} onBlur={() => save({ barcode: barcode.trim() || null })} placeholder={t('products.drawer.variants.barcodePlaceholder')} className={ROW_FIELD_CLASS} />
    </div></TableCell>
    <TableCell className="p-2"><CurrencyInput aria-label={`${t('products.detail.fields.purchase')} · ${label}`} value={purchasePrice} onChange={(e) => setPurchasePrice(e.target.value)} onBlur={() => save({ purchase_price: purchasePrice ? Number(purchasePrice) : null })} placeholder={formatCurrency(product.purchase_price, product.currency)} className={`${ROW_FIELD_CLASS} pl-6 pr-1`} /></TableCell>
    <TableCell className="p-2"><CurrencyInput aria-label={`${t('products.detail.fields.wholesale')} · ${label}`} value={wholesalePrice} onChange={(e) => setWholesalePrice(e.target.value)} onBlur={() => save({ wholesale_price: wholesalePrice ? Number(wholesalePrice) : null })} placeholder={formatCurrency(product.wholesale_price, product.currency)} className={`${ROW_FIELD_CLASS} pl-6 pr-1`} /></TableCell>
    <TableCell className="p-2"><CurrencyInput aria-label={`${t('products.detail.fields.retail')} · ${label}`} value={retailPrice} onChange={(e) => setRetailPrice(e.target.value)} onBlur={() => save({ retail_price: retailPrice ? Number(retailPrice) : null })} placeholder={formatCurrency(product.retail_price, product.currency)} className={`${ROW_FIELD_CLASS} pl-6 pr-1`} /></TableCell>
    <TableCell className="p-2 pt-4 text-center text-xs tabular-nums">{stock?.available ?? '—'}</TableCell>
    <TableCell className="p-2 pt-3"><Switch aria-label={`${t('common.status.active')} · ${label}`} checked={variant.is_active} onCheckedChange={(checked) => save({ is_active: checked })} /></TableCell>
    <TableCell className="p-2"><Button type="button" variant="ghost" size="sm" onClick={handleDelete} className="h-8 px-1 text-xs text-destructive">{t('common.actions.delete')}</Button></TableCell>
  </TableRow>
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
  const [page, setPage] = useState(1)
  const totalPages = Math.max(1, Math.ceil(product.variants.length / 3))
  const activePage = Math.min(page, totalPages)
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
          // Nunca se genera un barcode -- a diferencia del SKU (que puede
          // derivarse del combo), un código de barras real solo lo puede
          // asignar quien tiene el producto físico en mano (o el que ya
          // traía impreso de fábrica), nunca inventarse.
          barcode: null,
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
    <div className="space-y-3">
      {!product.has_variants && <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium">{t('products.drawer.variants.enable')}</span>
        <Switch aria-label={t('products.drawer.variants.enable')} checked={product.has_variants} onCheckedChange={handleToggle} disabled={hasExistingStock} />
      </div>}
      {!product.has_variants && hasExistingStock && <p className="text-xs text-amber-600">{t('products.detail.variants.errors.existingStockBlocksEnable')}</p>}

      {product.has_variants && (
        <div className="flex flex-col gap-4">
          <div className="space-y-3">
            {optionsDraft.map((option, index) => (
              <div key={index} className="flex items-center gap-2">
                <div className="w-28 shrink-0">
                  <Input value={option.name} onChange={(e) => updateOption(index, { name: e.target.value })} placeholder={t('products.drawer.variants.optionNamePlaceholder')} className="h-8 text-xs" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-xs">
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

          {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}

          {product.variants.length > 0 ? (
            <div className="overflow-hidden rounded-md border border-border">
              <Table className="w-full table-fixed min-w-[740px]">
                <TableHeader><TableRow>
                  <TableHead className="w-[17%] px-2">{t('products.detail.sections.variants')}</TableHead>
                  <TableHead className="w-[22%] px-2">SKU / {t('products.detail.fields.barcode')}</TableHead>
                  <TableHead className="w-[12%] px-2">{t('products.detail.fields.purchase')}</TableHead>
                  <TableHead className="w-[12%] px-2">{t('products.detail.fields.wholesale')}</TableHead>
                  <TableHead className="w-[12%] px-2">{t('products.detail.fields.retail')}</TableHead>
                  <TableHead className="w-[9%] px-2 text-center">{t('inventory.product.table.available')}</TableHead>
                  <TableHead className="w-[7%] px-2">{t('common.status.active')}</TableHead>
                  <TableHead className="w-[9%] px-2">{t('products.table.actions')}</TableHead>
                </TableRow></TableHeader>
                <TableBody>{product.variants.slice((activePage - 1) * 3, activePage * 3).map((variant) => (
                  <VariantRow key={variant.id} tenantId={tenantId} product={product} variant={variant} options={optionsDraft} stock={stockTotals.get(variant.id)} onChanged={onChanged} />
                ))}</TableBody>
              </Table>
              {totalPages > 1 && <Pagination page={activePage} totalPages={totalPages} onChange={setPage} />}
            </div>
          ) : (
            optionsDraft.length > 0 && <p className="text-xs text-brand-400">{t('products.drawer.variants.empty')}</p>
          )}
        </div>
      )}
    </div>
  )
}
