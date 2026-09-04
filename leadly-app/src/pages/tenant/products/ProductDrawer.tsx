import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { CheckIcon, PlusIcon as PlusIconLucide, XIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { createProduct, deleteProductImage, getProductImageUrl, updateProduct, uploadProductImage, validateProductImageFile } from '../../../lib/api/products'
import type { ProductWithImages } from '../../../lib/api/products'
import { listProductCategories, flattenCategoryTree } from '../../../lib/api/productCategories'
import { listSuppliers } from '../../../lib/api/suppliers'
import { listBrands } from '../../../lib/api/brands'
import type { Brand, ProductCategory, Supplier } from '../../../types/domain'
import { useLanguage } from '../../../contexts/LanguageContext'
import { FieldError, ProductImage } from '@/components/atoms'
import { ComboboxFilter, CurrencyInput } from '@/components/molecules'
import { Drawer } from '@/components/organisms'
import { PlusIcon, TrashIcon } from '@/components/atoms/icons'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { isNotBlank } from '../../../lib/validation'
import { listTaxTypes } from '../../../lib/api/tenantDianProfile'
import type { TaxType } from '../../../types/domain'

// The exact sizing the Products list's filter pills use (CategoryTreeFilter/
// ComboboxFilter triggers, `size="sm"` on Button) -- every field in this
// form is pinned to it so the drawer doesn't feel like a visually separate,
// bigger design system from the list it edits. `!`-prefixed because Input/
// Textarea/CurrencyInput each carry their own baked-in size (shadcn Input's
// h-8, and a `md:text-sm` responsive override that would otherwise win back
// over a plain `text-xs` at desktop widths) that a same-specificity class
// can't reliably beat.
const FIELD_CLASS = '!h-7 !rounded-lg !text-xs'
const TEXTAREA_CLASS = '!rounded-lg !py-1.5 !text-xs'
// ComboboxFilter's own trigger sits in a flex row *with* its clear button --
// a plain `w-full` there would fight that sibling for space; `flex-1` grows
// to fill what's left instead.
const COMBOBOX_TRIGGER_CLASS = 'flex-1 !rounded-lg'

/** Small uppercase label above a group of related fields -- breaks the form
 * into scannable sections (Información básica / Categorización / Precios /
 * Inventario) instead of one undifferentiated stack, the main thing that
 * made the old version feel like a wall of fields. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-2.5">
      <p className="text-[11px] font-semibold tracking-wide text-brand-400 uppercase">{title}</p>
      {children}
    </div>
  )
}

/** Images only make sense once the product exists in the DB
 * (product_images.product_id needs a real row to point at) -- same
 * rule as TaskAttachments, so this section only renders while editing. */
function ProductImages({ tenantId, product, onChanged }: { tenantId: string; product: ProductWithImages; onChanged: () => void }) {
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
      await uploadProductImage(tenantId, product.id, file, product.images.length)
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
    <Section title={t('products.drawer.images.label')}>
      <div className="flex flex-wrap gap-2">
        {product.images.map((img) => (
          <div key={img.id} className="group relative h-16 w-16 overflow-hidden rounded-lg border border-brand-100">
            <img src={getProductImageUrl(img.storage_path)} alt="" className="h-full w-full object-cover" />
            <button
              type="button"
              onClick={() => handleRemove(img.id, img.storage_path)}
              className="absolute inset-0 flex items-center justify-center bg-black/50 text-white opacity-0 transition-opacity group-hover:opacity-100"
              aria-label={t('products.drawer.images.removeAria')}
            >
              <TrashIcon width={16} height={16} />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
          className="flex h-16 w-16 items-center justify-center rounded-lg border border-dashed border-brand-300 text-brand-400 hover:border-accent-400 hover:text-accent-500"
        >
          <PlusIcon width={16} height={16} />
        </button>
      </div>
      <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={handleSelect} />
      {uploading && <p className="text-xs text-brand-400">{t('products.drawer.images.uploading')}</p>}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </Section>
  )
}

/** Multi-select combobox -- chips for whatever's picked plus an "Agregar"
 * trigger live together in one bordered field (same shape as TagInput's
 * chip-box, just picking from a fixed tree instead of typing free text)
 * instead of a separate button-then-chips-below layout, so it visibly reads
 * as "pick several" rather than a single-select dropdown that happens to
 * hold a list. Each row in the popover shows an explicit checkbox (not a
 * subtle built-in checkmark) so which categories are already picked stays
 * visible while still browsing/searching the tenant's parent/child tree,
 * not just after closing it. Clicking a row toggles it without closing the
 * popover -- picking several in a row shouldn't need reopening it each time. */
function CategoryMultiSelect({ categories, selectedIds, onChange }: { categories: ProductCategory[]; selectedIds: string[]; onChange: (ids: string[]) => void }) {
  const { t } = useLanguage()
  const [open, setOpen] = useState(false)
  // Una categoría desactivada no se puede sumar a un producto nuevo, pero si
  // este producto ya la tenía enlazada de antes sigue apareciendo (acá, y
  // como chip abajo) -- desactivar nunca le quita nada a lo ya creado, solo
  // deja de ofrecerse como opción nueva. `categories` sí trae la lista
  // completa (activas e inactivas) para que ese chip ya enlazado pueda
  // seguir resolviendo su nombre.
  const nodes = flattenCategoryTree(categories).filter(({ category }) => category.is_active || selectedIds.includes(category.id))
  const selected = categories.filter((c) => selectedIds.includes(c.id))

  function toggle(id: string) {
    onChange(selectedIds.includes(id) ? selectedIds.filter((i) => i !== id) : [...selectedIds, id])
  }

  return (
    <div>
      <Label>{t('products.drawer.fields.categories')}</Label>
      {categories.length === 0 ? (
        <p className="mt-1 text-xs text-brand-400">{t('products.drawer.fields.noCategories')}</p>
      ) : (
        <div className="mt-1 flex min-h-7 flex-wrap items-center gap-1.5 rounded-lg border border-input px-1.5 py-1">
          {selected.map((c) => (
            <Badge key={c.id} variant="secondary" className="gap-1 pr-1 text-xs font-normal">
              {c.name}
              <button type="button" onClick={() => toggle(c.id)} aria-label={c.name} className="rounded-full p-0.5 hover:bg-black/10">
                <XIcon className="size-3" />
              </button>
            </Badge>
          ))}
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <button type="button" className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
                <PlusIconLucide className="size-3" />
                {t('products.drawer.fields.addCategory')}
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-72 p-0" align="start">
              <Command>
                <CommandInput placeholder={t('products.list.searchCategory')} className="text-xs" />
                <CommandList>
                  <CommandEmpty className="text-xs">{t('products.list.noCategoryResults')}</CommandEmpty>
                  <CommandGroup>
                    {nodes.map(({ category, depth }) => {
                      const checked = selectedIds.includes(category.id)
                      return (
                        <CommandItem
                          key={category.id}
                          value={category.name}
                          onSelect={() => toggle(category.id)}
                          className="text-xs"
                          style={{ paddingLeft: `${depth * 14 + 8}px` }}
                        >
                          <span
                            className={cn(
                              'flex size-3.5 shrink-0 items-center justify-center rounded-sm border',
                              checked ? 'border-primary bg-primary text-primary-foreground' : 'border-input',
                            )}
                          >
                            {checked && <CheckIcon className="size-2.5" />}
                          </span>
                          <span className="flex-1 truncate">{category.name}</span>
                        </CommandItem>
                      )
                    })}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        </div>
      )}
    </div>
  )
}

export function ProductDrawer({
  open,
  onClose,
  tenantId,
  product,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  tenantId: string
  /** Present when editing an existing product; omitted when creating a new one. */
  product?: ProductWithImages | null
  onSaved: () => void
}) {
  const { t } = useLanguage()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [sku, setSku] = useState('')
  const [barcode, setBarcode] = useState('')
  const [slug, setSlug] = useState('')
  const [categoryIds, setCategoryIds] = useState<string[]>([])
  const [supplierId, setSupplierId] = useState('')
  const [brandId, setBrandId] = useState('')
  const [categories, setCategories] = useState<ProductCategory[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [brands, setBrands] = useState<Brand[]>([])
  const [purchasePrice, setPurchasePrice] = useState('')
  const [wholesalePrice, setWholesalePrice] = useState('')
  const [retailPrice, setRetailPrice] = useState('')
  const [trackInventory, setTrackInventory] = useState(true)
  const [lowStockThreshold, setLowStockThreshold] = useState('5')
  const [isActive, setIsActive] = useState(true)
  const [taxTypeCode, setTaxTypeCode] = useState('01')
  const [taxRate, setTaxRate] = useState('19')
  const [taxTypes, setTaxTypes] = useState<TaxType[]>([])
  const [touched, setTouched] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setName(product?.name ?? '')
    setDescription(product?.description ?? '')
    setSku(product?.sku ?? '')
    setBarcode(product?.barcode ?? '')
    setSlug(product?.slug ?? '')
    setCategoryIds(product?.categories.map((c) => c.id) ?? [])
    setSupplierId(product?.supplier_id ?? '')
    setBrandId(product?.brand_id ?? '')
    setPurchasePrice(product?.purchase_price != null ? String(product.purchase_price) : '')
    setWholesalePrice(product?.wholesale_price != null ? String(product.wholesale_price) : '')
    setRetailPrice(product?.retail_price != null ? String(product.retail_price) : '')
    setTrackInventory(product?.track_inventory ?? true)
    setLowStockThreshold(product ? String(product.low_stock_threshold) : '5')
    setIsActive(product?.is_active ?? true)
    setTaxTypeCode(product?.tax_type_code ?? '01')
    setTaxRate(product ? String(product.tax_rate) : '19')
    setTouched(false)
    setFormError(null)
  }, [open, product])

  useEffect(() => {
    if (!open) return
    listProductCategories(tenantId).then(setCategories).catch(() => {})
    listSuppliers(tenantId).then(setSuppliers).catch(() => {})
    listBrands(tenantId).then(setBrands).catch(() => {})
    listTaxTypes()
      .then((types) => setTaxTypes(types.filter((tx) => tx.category === 'impuesto')))
      .catch(() => {})
  }, [open, tenantId])

  const nameError = touched && !isNotBlank(name) ? t('products.drawer.errors.nameRequired') : undefined

  function toNumberOrNull(value: string): number | null {
    if (!isNotBlank(value)) return null
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    setFormError(null)
    if (!isNotBlank(name)) return

    setSubmitting(true)
    try {
      const input = {
        tenant_id: tenantId,
        name: name.trim(),
        description: description.trim() || null,
        sku: sku.trim() || null,
        barcode: barcode.trim() || null,
        slug: slug.trim() || null,
        supplier_id: supplierId || null,
        brand_id: brandId || null,
        purchase_price: toNumberOrNull(purchasePrice),
        wholesale_price: toNumberOrNull(wholesalePrice),
        retail_price: toNumberOrNull(retailPrice),
        track_inventory: trackInventory,
        low_stock_threshold: Math.max(0, Math.trunc(Number(lowStockThreshold) || 0)),
        is_active: isActive,
        tax_type_code: taxTypeCode || null,
        tax_rate: Number(taxRate) || 0,
      }
      // has_variants is deliberately not touched by this form -- it's
      // managed from ProductDetail's Variantes card instead (more room for
      // the options/combinations/per-variant photos flow than this drawer
      // has), same reasoning as images already needing a real product id.
      if (product) await updateProduct(product.id, input, categoryIds)
      else await createProduct(input, categoryIds)
      onSaved()
      onClose()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('products.drawer.errors.save'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Drawer open={open} onClose={onClose} title={product ? t('products.drawer.editTitle') : t('products.drawer.newTitle')} description={t('products.drawer.description')} size="lg">
      <form onSubmit={handleSubmit} noValidate className="space-y-5">
        {/* Cover thumbnail + name -- puts a face on the product right away
            (reuses the same colored-initials placeholder the list/detail
            pages fall back to when there's no photo yet), instead of the
            name field floating alone at the top like every other text field. */}
        <div className="flex items-center gap-3">
          <div className="h-12 w-12 shrink-0 overflow-hidden rounded-lg border border-brand-100">
            <ProductImage src={product?.images[0] ? getProductImageUrl(product.images[0].storage_path) : null} name={name || '?'} className="h-full w-full" iconSize={20} />
          </div>
          <div className="min-w-0 flex-1">
            <Label htmlFor="product-name">{t('products.drawer.fields.name')}</Label>
            <Input
              id="product-name"
              value={name}
              aria-invalid={!!nameError}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('products.drawer.fields.namePlaceholder')}
              className={`mt-1 ${FIELD_CLASS}`}
            />
            <FieldError message={nameError} />
          </div>
        </div>

        <Section title={t('products.drawer.sections.basics')}>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <Label htmlFor="product-sku">{t('products.drawer.fields.sku')}</Label>
              <Input id="product-sku" value={sku} onChange={(e) => setSku(e.target.value)} placeholder={t('products.drawer.fields.skuPlaceholder')} className={`mt-1 ${FIELD_CLASS}`} />
            </div>
            <div>
              <Label htmlFor="product-barcode">{t('products.drawer.fields.barcode')}</Label>
              <Input
                id="product-barcode"
                value={barcode}
                onChange={(e) => setBarcode(e.target.value)}
                placeholder={t('products.drawer.fields.barcodePlaceholder')}
                className={`mt-1 ${FIELD_CLASS}`}
              />
            </div>
            <div>
              <Label htmlFor="product-slug">{t('products.drawer.fields.slug')}</Label>
              <Input id="product-slug" value={slug} onChange={(e) => setSlug(e.target.value)} placeholder={t('products.drawer.fields.slugPlaceholder')} className={`mt-1 ${FIELD_CLASS}`} />
            </div>
          </div>
          <div>
            <Label htmlFor="product-description">{t('products.drawer.fields.description')}</Label>
            <Textarea id="product-description" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} className={`mt-1 ${TEXTAREA_CLASS}`} />
          </div>
        </Section>

        <Section title={t('products.drawer.sections.classification')}>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>{t('products.drawer.fields.brand')}</Label>
              <div className="mt-1">
                <ComboboxFilter
                  // Marcas inactivas no son elegibles para un producto nuevo
                  // -- salvo la que el producto ya tuviera asignada, para
                  // que editarlo no la borre en silencio del selector (sigue
                  // viéndose, solo no aparece como opción para asignarla de
                  // nuevo desde otro producto).
                  options={brands.filter((b) => b.is_active || b.id === brandId).map((b) => ({ id: b.id, label: b.name }))}
                  value={brandId || null}
                  onChange={(id) => setBrandId(id ?? '')}
                  placeholder={t('products.drawer.fields.noBrand')}
                  searchPlaceholder={t('products.list.searchBrand')}
                  emptyLabel={t('products.list.noBrandResults')}
                  className="w-full"
                  triggerClassName={COMBOBOX_TRIGGER_CLASS}
                />
              </div>
            </div>
            <div>
              <Label>{t('products.drawer.fields.supplier')}</Label>
              <div className="mt-1">
                <ComboboxFilter
                  // Mismo criterio que Marca -- ver comentario arriba.
                  options={suppliers.filter((s) => s.is_active || s.id === supplierId).map((s) => ({ id: s.id, label: s.name }))}
                  value={supplierId || null}
                  onChange={(id) => setSupplierId(id ?? '')}
                  placeholder={t('products.drawer.fields.noSupplier')}
                  searchPlaceholder={t('products.drawer.fields.searchSupplier')}
                  emptyLabel={t('products.drawer.fields.noSupplierResults')}
                  className="w-full"
                  triggerClassName={COMBOBOX_TRIGGER_CLASS}
                />
              </div>
            </div>
          </div>
          <CategoryMultiSelect categories={categories} selectedIds={categoryIds} onChange={setCategoryIds} />
        </Section>

        <Section title={t('products.drawer.sections.pricing')}>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <Label htmlFor="product-purchase-price">{t('products.drawer.fields.purchasePrice')}</Label>
              <CurrencyInput id="product-purchase-price" value={purchasePrice} onChange={(e) => setPurchasePrice(e.target.value)} className={`mt-1 ${FIELD_CLASS}`} />
            </div>
            <div>
              <Label htmlFor="product-wholesale-price">{t('products.drawer.fields.wholesalePrice')}</Label>
              <CurrencyInput id="product-wholesale-price" value={wholesalePrice} onChange={(e) => setWholesalePrice(e.target.value)} className={`mt-1 ${FIELD_CLASS}`} />
            </div>
            <div>
              <Label htmlFor="product-retail-price">{t('products.drawer.fields.retailPrice')}</Label>
              <CurrencyInput id="product-retail-price" value={retailPrice} onChange={(e) => setRetailPrice(e.target.value)} className={`mt-1 ${FIELD_CLASS}`} />
            </div>
          </div>
        </Section>

        <Section title={t('products.drawer.sections.tax')}>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="product-tax-type">{t('products.drawer.fields.taxType')}</Label>
              <Select value={taxTypeCode} onValueChange={setTaxTypeCode}>
                <SelectTrigger id="product-tax-type" className={`mt-1 w-full ${FIELD_CLASS}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {taxTypes.map((tx) => (
                    <SelectItem key={tx.code} value={tx.code} className="text-xs">
                      {tx.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="product-tax-rate">{t('products.drawer.fields.taxRate')}</Label>
              <Input id="product-tax-rate" type="number" min={0} max={100} step={0.5} value={taxRate} onChange={(e) => setTaxRate(e.target.value)} className={`mt-1 ${FIELD_CLASS}`} />
            </div>
          </div>
          <p className="text-[11px] text-brand-400">{t('products.drawer.fields.taxHint')}</p>
        </Section>

        <Section title={t('products.drawer.sections.inventory')}>
          <div className="divide-y divide-brand-100 rounded-lg border border-brand-100">
            <div className="flex items-center justify-between px-3 py-2.5">
              <Label htmlFor="product-track-inventory" className="font-normal text-brand-700">
                {t('products.drawer.fields.trackInventory')}
              </Label>
              <Switch id="product-track-inventory" checked={trackInventory} onCheckedChange={setTrackInventory} />
            </div>
            {trackInventory && (
              <div className="px-3 py-2.5">
                <Label htmlFor="product-low-stock">{t('products.drawer.fields.lowStockAlert')}</Label>
                <Input id="product-low-stock" type="number" min="0" step="1" value={lowStockThreshold} onChange={(e) => setLowStockThreshold(e.target.value)} className={`mt-1 w-28 ${FIELD_CLASS}`} />
              </div>
            )}
            <div className="flex items-center justify-between px-3 py-2.5">
              <Label htmlFor="product-active" className="font-normal text-brand-700">
                {t('products.drawer.fields.active')}
              </Label>
              <Switch id="product-active" checked={isActive} onCheckedChange={setIsActive} />
            </div>
          </div>
        </Section>

        {product && <ProductImages tenantId={tenantId} product={product} onChanged={onSaved} />}

        {formError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</p>}

        <div className="flex gap-2 border-t border-brand-100 pt-4">
          <Button type="submit" disabled={submitting}>
            {submitting ? t('common.actions.saving') : t('common.actions.save')}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('common.actions.cancel')}
          </Button>
        </div>
      </form>
    </Drawer>
  )
}
