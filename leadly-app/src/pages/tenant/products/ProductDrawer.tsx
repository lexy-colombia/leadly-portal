import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { CheckIcon, PlusIcon as PlusIconLucide, XIcon } from 'lucide-react'
import { FormSection as Section, FormToggle } from '@/components/molecules/FormSection'
import { ImageGalleryField } from '@/components/molecules/ImageGalleryField'
import { cn } from '@/lib/utils'
import { createProduct, deleteProductImage, getProductImageUrl, updateProduct, uploadProductImage, validateProductImageFile } from '../../../lib/api/products'
import type { ProductWithImages } from '../../../lib/api/products'
import { listProductCategories, flattenCategoryTree } from '../../../lib/api/productCategories'
import { listSuppliers } from '../../../lib/api/suppliers'
import { listBrands } from '../../../lib/api/brands'
import type { Brand, InventoryMode, ProductCategory, Supplier } from '../../../types/domain'
import { usePermission } from '../../../contexts/AuthContext'
import { ProductBomSection } from './ProductBomSection'
import { useLanguage } from '../../../contexts/LanguageContext'
import { FieldError } from '@/components/atoms'
import { ComboboxFilter, CurrencyInput } from '@/components/molecules'
import { Drawer } from '@/components/organisms'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
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
// h-8, and a `md:text-xs` responsive override that would otherwise win back
// over a plain `text-xs` at desktop widths) that a same-specificity class
// can't reliably beat.
const FIELD_CLASS = '!h-7 !rounded-lg !text-xs'
const TEXTAREA_CLASS = '!rounded-lg !py-1.5 !text-xs'
// ComboboxFilter's own trigger sits in a flex row *with* its clear button --
// a plain `w-full` there would fight that sibling for space; `flex-1` grows
// to fill what's left instead.
const COMBOBOX_TRIGGER_CLASS = 'flex-1 !rounded-lg'

/** Images only make sense once the product exists in the DB
 * (product_images.product_id needs a real row to point at) -- same
 * rule as TaskAttachments, so this section only renders while editing. */
function ProductImages({ tenantId, product, onChanged }: { tenantId: string; product: ProductWithImages; onChanged: () => void }) {
  const { t } = useLanguage()
  const [images, setImages] = useState(product.images)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => setImages(product.images), [product.id, product.images])

  async function handleSelect(files: File[]) {
    const invalid = files.map(validateProductImageFile).find(Boolean)
    if (invalid) { setError(t(invalid)); return }
    setError(null)
    setUploading(true)
    let changed = false
    try {
      let order = Math.max(-1, ...images.map((image) => image.display_order)) + 1
      for (const file of files) {
        const image = await uploadProductImage(tenantId, product.id, file, order++)
        setImages((prev) => [...prev, image])
        changed = true
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('products.drawer.images.uploadError'))
    } finally {
      setUploading(false)
      if (changed) onChanged()
    }
  }

  async function handleRemove(imageId: string) {
    const image = images.find((item) => item.id === imageId)
    if (!image) return
    setUploading(true)
    setError(null)
    try {
      await deleteProductImage(image.id, image.storage_path)
      setImages((prev) => prev.filter((item) => item.id !== imageId))
      onChanged()
    } catch {
      setError(t('products.drawer.images.removeError'))
    } finally {
      setUploading(false)
    }
  }

  return <div className="flex flex-col gap-1">
    <ImageGalleryField images={images.map((image) => ({ id: image.id, src: getProductImageUrl(image.storage_path) }))} label={t('products.drawer.images.label')} addLabel={t('products.drawer.images.add')} removeLabel={t('products.drawer.images.removeAria')} busy={uploading} onAdd={handleSelect} onRemove={handleRemove} />
    {uploading && <p role="status" className="text-xs text-muted-foreground">{t('products.drawer.images.uploading')}</p>}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
  </div>
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
  const formId = useId()
  const nameRef = useRef<HTMLInputElement>(null)
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
  const [inventoryMode, setInventoryMode] = useState<InventoryMode>('stock')
  const canManageBom = usePermission('products.manage_bom')
  const [lowStockThreshold, setLowStockThreshold] = useState('5')
  const [isActive, setIsActive] = useState(true)
  const [visibleInCatalog, setVisibleInCatalog] = useState(false)
  const [taxTypeCode, setTaxTypeCode] = useState('01')
  const [taxRate, setTaxRate] = useState('19')
  const [taxTypes, setTaxTypes] = useState<TaxType[]>([])
  // Si el catálogo de impuestos no carga, el selector quedaba vacío y SIN
  // opciones, sin ningún aviso (el .catch lo tragaba) -- bug real reportado
  // 2026-09-13: no había forma de setear el tipo de impuesto de un producto
  // y no se entendía por qué. Ahora el error se ve y se puede reintentar.
  const [taxTypesError, setTaxTypesError] = useState(false)
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
    setInventoryMode(product?.inventory_mode ?? 'stock')
    setLowStockThreshold(product ? String(product.low_stock_threshold) : '5')
    setIsActive(product?.is_active ?? true)
    setVisibleInCatalog(product?.is_visible_in_catalog ?? false)
    // Un producto que hoy NO tiene tipo de impuesto arranca vacío, no en
    // IVA: con el default anterior, abrir su ficha y guardar cualquier otro
    // campo le escribía '01' en silencio, sin que nadie lo eligiera.
    setTaxTypeCode(product ? (product.tax_type_code ?? '') : '01')
    setTaxRate(product ? String(product.tax_rate) : '19')
    setTouched(false)
    setFormError(null)
  }, [open, product])

  useEffect(() => {
    if (!open) return
    listProductCategories(tenantId).then(setCategories).catch(() => {})
    listSuppliers(tenantId).then(setSuppliers).catch(() => {})
    listBrands(tenantId).then(setBrands).catch(() => {})
    loadTaxTypes()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tenantId])

  function loadTaxTypes() {
    setTaxTypesError(false)
    listTaxTypes()
      .then((types) => setTaxTypes(types.filter((tx) => tx.category === 'impuesto')))
      .catch(() => setTaxTypesError(true))
  }

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
    if (!isNotBlank(name)) { nameRef.current?.focus(); return }

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
        // Un producto "se arma con insumos" se queda con track_inventory=true:
        // el backend deriva su disponible de los insumos y los flujos de venta
        // (listados, POS) piden disponibilidad solo de los que controlan inventario.
        track_inventory: inventoryMode === 'recipe' ? true : trackInventory,
        inventory_mode: inventoryMode,
        low_stock_threshold: Math.max(0, Math.trunc(Number(lowStockThreshold) || 0)),
        is_active: isActive,
        is_visible_in_catalog: visibleInCatalog,
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
    <Drawer open={open} onClose={onClose} title={product ? t('products.drawer.editTitle') : t('products.drawer.newTitle')} size="xl" footer={
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onClose}>{t('common.actions.cancel')}</Button>
        <Button type="submit" form={formId} disabled={submitting}>{submitting ? t('common.actions.saving') : t('common.actions.saveChanges')}</Button>
      </div>
    }>
      <form id={formId} onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
        <div className="flex items-start gap-4">
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <div><Label htmlFor="product-name">{t('products.drawer.fields.name')}</Label><Input ref={nameRef} id="product-name" value={name} aria-invalid={!!nameError} onChange={(e) => setName(e.target.value)} className={`mt-1 ${FIELD_CLASS}`} /><FieldError message={nameError} /></div>
            <div>
              <Label htmlFor="product-description">{t('products.drawer.compact.description')}</Label>
              <Textarea id="product-description" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} className={`mt-1 ${TEXTAREA_CLASS}`} />
            </div>
          </div>
        </div>
        {product && <ProductImages key={product.id} tenantId={tenantId} product={product} onChanged={onSaved} />}
        <Section title={t('products.drawer.sections.classification')}>
          <CategoryMultiSelect categories={categories} selectedIds={categoryIds} onChange={setCategoryIds} />
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>{t('products.drawer.compact.brand')}</Label>
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
              <Label>{t('products.drawer.compact.supplier')}</Label>
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
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <Label htmlFor="product-sku">{t('products.drawer.compact.sku')}</Label>
              <Input id="product-sku" value={sku} onChange={(e) => setSku(e.target.value)} placeholder={t('products.drawer.fields.skuPlaceholder')} className={`mt-1 ${FIELD_CLASS}`} />
            </div>
            <div>
              <Label htmlFor="product-barcode">{t('products.drawer.compact.barcode')}</Label>
              <Input
                id="product-barcode"
                value={barcode}
                onChange={(e) => setBarcode(e.target.value)}
                placeholder={t('products.drawer.fields.barcodePlaceholder')}
                className={`mt-1 ${FIELD_CLASS}`}
              />
            </div>
            <div>
              <Label htmlFor="product-slug">{t('products.drawer.compact.slug')}</Label>
              <Input id="product-slug" value={slug} onChange={(e) => setSlug(e.target.value)} placeholder={t('products.drawer.fields.slugPlaceholder')} className={`mt-1 ${FIELD_CLASS}`} />
            </div>
          </div>
        </Section>


        <Section title={t('products.drawer.sections.pricingAndTax')}>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
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
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="product-tax-type">{t('products.drawer.fields.taxType')}</Label>
              {/* ⚠️ El Select NO se monta hasta tener el catálogo cargado.
               * Bug real (2026-09-13): el tipo de impuesto de un producto no
               * se podía cambiar y "se perdía" al guardar. Causa: este Select
               * vive dentro de un <form>, así que Radix renderiza un <select>
               * nativo oculto para la semántica de formulario. Montado con un
               * valor ('04') que todavía no existe como <option> (el catálogo
               * llega por fetch, milisegundos después), el navegador deja ese
               * campo nativo en "" y Radix devuelve ese "" por onValueChange
               * -- pisando el valor real del producto sin que nadie tocara
               * nada. Se veía como un selector en blanco. */}
              {taxTypes.length === 0 ? (
                <div className={`mt-1 flex w-full items-center rounded-lg border border-input px-2.5 text-xs text-brand-400 ${FIELD_CLASS}`}>
                  {taxTypesError ? '—' : t('common.status.loading')}
                </div>
              ) : (
                <Select value={taxTypeCode} onValueChange={setTaxTypeCode}>
                  <SelectTrigger id="product-tax-type" className={`mt-1 w-full ${FIELD_CLASS}`}>
                    {/* Radix only learns an item's label once SelectContent has
                     * mounted (i.e. after the dropdown has been opened once),
                     * so an empty <SelectValue /> renders blank on first paint
                     * even though taxTypeCode already has a real value -- pass
                     * the matched label explicitly instead of relying on that. */}
                    <SelectValue>
                      {taxTypes.find((tx) => tx.code === taxTypeCode)?.name ?? (taxTypeCode || undefined)}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {taxTypes.map((tx) => (
                      <SelectItem key={tx.code} value={tx.code} className="text-xs">
                        {tx.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {taxTypesError && (
                <p className="mt-1 flex items-center gap-2 text-[11px] text-red-700">
                  {t('products.drawer.fields.taxTypeLoadError')}
                  <button type="button" onClick={loadTaxTypes} className="underline">
                    {t('common.actions.retry')}
                  </button>
                </p>
              )}
            </div>
            <div>
              <Label htmlFor="product-tax-rate">{t('products.drawer.fields.taxRate')}</Label>
              <Input id="product-tax-rate" type="number" min={0} max={100} step={0.5} value={taxRate} onChange={(e) => setTaxRate(e.target.value)} className={`mt-1 ${FIELD_CLASS}`} />
            </div>
          </div>
        </Section>


        <Section title={t('products.drawer.sections.inventory')}>
          <div className="grid grid-cols-2 items-start gap-3">
            <div>              <Label htmlFor="product-inventory-mode">{t('products.drawer.fields.inventoryMode')}</Label>
              <Select value={inventoryMode} onValueChange={(v) => setInventoryMode(v as InventoryMode)} disabled={!canManageBom || !!product?.has_variants}>
                <SelectTrigger id="product-inventory-mode" title={product?.has_variants ? t('products.drawer.inventoryMode.variantsHint') : !canManageBom ? t('products.drawer.inventoryMode.noPermission') : undefined} className={`mt-1 w-full ${FIELD_CLASS}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="stock" className="text-xs">
                    {t('products.drawer.inventoryMode.stock')}
                  </SelectItem>
                  <SelectItem value="recipe" className="text-xs">
                    {t('products.drawer.inventoryMode.recipe')}
                  </SelectItem>
                </SelectContent>
              </Select>
</div>
            {inventoryMode === 'stock' && trackInventory && <div><Label htmlFor="product-low-stock">{t('products.drawer.fields.lowStockAlert')}</Label><Input id="product-low-stock" type="number" min="0" step="1" value={lowStockThreshold} onChange={(e) => setLowStockThreshold(e.target.value)} className={`mt-1 ${FIELD_CLASS}`} /></div>}
          </div>
          {inventoryMode === 'stock' && <FormToggle id="product-track-inventory" label={t('products.drawer.fields.trackInventory')} checked={trackInventory} onCheckedChange={setTrackInventory} />}
          {inventoryMode === 'recipe' && product && product.inventory_mode !== 'recipe' && <p role="status" className="text-xs text-amber-700">{t('products.drawer.inventoryMode.switchWarning')}</p>}
        </Section>

        {inventoryMode === 'recipe' && (
          <Section title={t('products.drawer.sections.bom')}>
            {product ? <ProductBomSection tenantId={tenantId} productId={product.id} onChanged={onSaved} /> : <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">{t('products.bom.saveFirst')}</p>}
          </Section>
        )}


        <Section title={t('products.drawer.sections.visibility')}>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormToggle id="product-active" label={t('products.drawer.fields.active')} checked={isActive} onCheckedChange={setIsActive} />
            <FormToggle id="product-visible-in-catalog" label={t('products.drawer.fields.visibleInCatalog')} checked={visibleInCatalog} onCheckedChange={setVisibleInCatalog} />
          </div>
        </Section>
        {formError && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{formError}</p>}
      </form>
    </Drawer>
  )
}
