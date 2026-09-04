import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { PackageIcon, PlusIcon, XIcon } from 'lucide-react'
import { useLanguage } from '../../../contexts/LanguageContext'
import { descendantIds } from '../../../lib/api/productCategories'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { CategoryTreeFilter, ComboboxFilter, CurrencyInput, IconInput } from '@/components/molecules'
import { ProductImage } from '@/components/atoms'
import { ScanIcon, TrashIcon } from '@/components/atoms/icons'
import type { OrderItemInput, StockShortfall } from '../../../lib/api/orders'
import { formatVariantLabel, getProductImageUrl, type ProductWithImages } from '../../../lib/api/products'
import type { ProductWarehouseStockRow } from '../../../lib/api/stockMovements'
import type { Brand, ProductCategory, ProductVariant, Warehouse } from '../../../types/domain'

function formatCurrency(value: number, currency = 'COP'): string {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value)
}

/** Sum of matching product_stock rows for one (product, variant, warehouse)
 * combination -- null when there isn't enough context yet (no product or no
 * warehouse picked on the line) to show a number at all. Variant-less
 * products only ever have variant_id null rows, so passing `variantId`
 * undefined/null there is correct, not a fallback. */
function availableStock(rows: ProductWarehouseStockRow[], productId: string | null | undefined, variantId: string | null | undefined, warehouseId: string | null | undefined): number | null {
  if (!productId || !warehouseId) return null
  return rows.filter((r) => r.product_id === productId && r.warehouse_id === warehouseId && r.variant_id === (variantId ?? null)).reduce((sum, r) => sum + r.quantity, 0)
}

/** Picks the line's photo: the variant's own image if one was uploaded for
 * it, else the product's general (variant-less) image, else whatever's
 * first -- never just images[0], which used to show whichever variant photo
 * happened to load first regardless of what was actually ordered. */
function resolveItemImage(product: ProductWithImages | undefined, variantId: string | null | undefined): string | null {
  if (!product) return null
  const image = (variantId && product.images.find((img) => img.variant_id === variantId))
    || product.images.find((img) => !img.variant_id)
    || product.images[0]
  return image ? getProductImageUrl(image.storage_path) : null
}

/** Exact-match lookup for a scanned barcode against the already-loaded
 * catalog -- no round trip needed, unlike PosFastCheckout's lookupPosBarcode,
 * because `products` here already embeds every variant (barcode included).
 * Checks variants first: a variant's code is more specific than its parent
 * product's, same precedence as the POS scanner. */
function findByBarcode(products: ProductWithImages[], code: string): { product: ProductWithImages; variant: ProductVariant | null } | null {
  const clean = code.trim()
  if (!clean) return null
  for (const product of products) {
    const variant = product.variants.find((v) => v.barcode === clean)
    if (variant) return { product, variant }
  }
  const product = products.find((p) => p.barcode === clean)
  return product ? { product, variant: null } : null
}

/** Line-item editor for an order -- one bordered card per product (image +
 * name/SKU + almacén + cantidad/precio/descuento/total), matching the
 * reference design. Adding a product no longer happens inline per-row:
 * "Agregar producto" opens a dedicated search panel (filters by categoría/
 * marca/con stock + free text over the already-loaded catalog) whose
 * results append a fully-formed line on click. A free-text custom line
 * (no product_id) is still available via a secondary button for anything
 * not in the catalog. */
export function OrderItemsEditor({
  items,
  products,
  categories,
  brands,
  warehouses,
  stockRows,
  shortfalls = [],
  currency = 'COP',
  locked = false,
  onChange,
}: {
  items: OrderItemInput[]
  products: ProductWithImages[]
  categories: ProductCategory[]
  brands: Brand[]
  warehouses: Warehouse[]
  stockRows: ProductWarehouseStockRow[]
  /** Lines a stock check just blocked on -- see StockShortfallDialog. Marks
   * that line's Cantidad input red so the agent doesn't have to cross-
   * reference the dialog's text against every row by eye. Cleared by the
   * parent the moment any item changes (stale otherwise). */
  shortfalls?: StockShortfall[]
  currency?: string
  /** true once the order stopped being 'cotizacion' (confirmada/cancelada)
   * -- a venta ya cerrada no se compone de nuevo desde acá (ver el mismo
   * candado real en calculate-order/index.ts, este prop es solo la parte
   * de UX: deshabilita los controles en vez de dejar que el agente edite y
   * recién se entere del error al perder el foco). */
  locked?: boolean
  onChange: (items: OrderItemInput[]) => void
}) {
  const { t } = useLanguage()
  const defaultWarehouseId = warehouses.find((w) => w.is_default)?.id ?? warehouses[0]?.id ?? null

  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [scanError, setScanError] = useState<string | null>(null)
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null)
  const [brandFilter, setBrandFilter] = useState<string | null>(null)
  const [stockOnly, setStockOnly] = useState(false)
  const [activeOnly, setActiveOnly] = useState(true)

  const categoryIds = useMemo(() => {
    if (!categoryFilter) return null
    return new Set([categoryFilter, ...Array.from(descendantIds(categories, categoryFilter))])
  }, [categoryFilter, categories])

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    return products
      .filter((p) => {
        if (activeOnly && !p.is_active) return false
        if (brandFilter && p.brand?.id !== brandFilter) return false
        if (categoryIds && !p.categories.some((c) => categoryIds.has(c.id))) return false
        if (stockOnly && !stockRows.some((r) => r.product_id === p.id && r.quantity > 0)) return false
        if (q && !p.name.toLowerCase().includes(q) && !(p.sku ?? '').toLowerCase().includes(q) && !(p.barcode ?? '').toLowerCase().includes(q)) return false
        return true
      })
      .slice(0, 30)
  }, [products, activeOnly, brandFilter, categoryIds, stockOnly, stockRows, defaultWarehouseId, query])

  function updateItem(index: number, patch: Partial<OrderItemInput>) {
    onChange(items.map((item, i) => (i === index ? { ...item, ...patch } : item)))
  }

  function removeItem(index: number) {
    onChange(items.filter((_, i) => i !== index))
  }

  /** `variant` is only passed by the barcode scanner (see handleScanSubmit)
   * -- clicking a search result never knows the variant upfront, that's
   * still resolved afterwards via the row's own variant Select. */
  function addProductLine(product: ProductWithImages, variant: ProductVariant | null = null) {
    onChange([
      ...items,
      {
        product_id: product.id,
        variant_id: variant?.id ?? null,
        warehouse_id: defaultWarehouseId,
        product_name: product.name,
        sku: variant?.sku ?? product.sku,
        quantity: 1,
        // A variant product's unit_price isn't known until a variant is
        // chosen -- see handleVariantSelect -- so this leaves it at 0 rather
        // than defaulting to the parent's retail_price, which would be
        // wrong for any variant that overrides its own price. A scanned
        // variant already carries its own price, so it skips that gap.
        unit_price: variant ? (variant.retail_price ?? product.retail_price ?? 0) : product.has_variants ? 0 : (product.retail_price ?? 0),
        discount_amount: 0,
        // Informativo nomás -- calculate-order (Edge Function) vuelve a
        // resolver el impuesto real del lado del servidor contra la tabla
        // products, nunca confía en este valor.
        tax_type_code: product.tax_type_code ?? null,
        tax_rate: product.tax_rate ?? 0,
      },
    ])
  }

  /** Scanner support: the barcode input is the same free-text search field
   * above -- a USB/Bluetooth reader just types fast and sends Enter, so
   * Enter always tries an EXACT match first (a partial/ilike match would be
   * wrong for a real barcode) before falling back to nothing, same
   * precedence PosFastCheckout uses. Typing and clicking a result row (the
   * fuzzy path) is untouched. */
  function handleScanSubmit() {
    const code = query.trim()
    if (!code) return
    const match = findByBarcode(products, code)
    if (!match) {
      setScanError(t('orders.itemsEditor.search.scanNotFound', { code }))
      return
    }
    addProductLine(match.product, match.variant)
    setQuery('')
    setScanError(null)
  }

  function addCustomLine() {
    onChange([...items, { product_id: null, warehouse_id: null, product_name: '', sku: null, quantity: 1, unit_price: 0, discount_amount: 0, tax_type_code: null, tax_rate: 0 }])
  }

  function handleVariantSelect(index: number, product: ProductWithImages, variantId: string) {
    const variant = product.variants.find((v) => v.id === variantId)
    if (!variant) return
    updateItem(index, {
      variant_id: variant.id,
      sku: variant.sku ?? product.sku,
      unit_price: variant.retail_price ?? product.retail_price ?? 0,
      tax_type_code: product.tax_type_code ?? null,
      tax_rate: product.tax_rate ?? 0,
    })
  }

  const searchPanel = searchOpen && (
    <div className="mt-3 rounded-lg border border-brand-100 bg-brand-50/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <CategoryTreeFilter
            categories={categories}
            value={categoryFilter}
            onChange={setCategoryFilter}
            placeholder={t('products.list.allCategories')}
            searchPlaceholder={t('products.list.searchCategory')}
            emptyLabel={t('products.list.noCategoryResults')}
            rootLabel={t('products.list.allCategories')}
            triggerClassName="h-8 rounded-lg text-xs"
          />
          <ComboboxFilter
            options={brands.map((b) => ({ id: b.id, label: b.name }))}
            value={brandFilter}
            onChange={setBrandFilter}
            placeholder={t('products.list.allBrands')}
            searchPlaceholder={t('products.list.searchBrand')}
            emptyLabel={t('products.list.noBrandResults')}
            triggerClassName="h-8 rounded-lg text-xs"
          />
          <Button type="button" variant={stockOnly ? 'secondary' : 'outline'} size="sm" className="h-8 rounded-lg text-xs" onClick={() => setStockOnly((v) => !v)}>
            {t('orders.itemsEditor.search.stockOnly')}
          </Button>
          <Button type="button" variant={activeOnly ? 'secondary' : 'outline'} size="sm" className="h-8 rounded-lg text-xs" onClick={() => setActiveOnly((v) => !v)}>
            {t('orders.itemsEditor.search.activeOnly')}
          </Button>
        </div>
        <Button type="button" variant="ghost" size="icon-sm" onClick={() => setSearchOpen(false)} aria-label={t('common.actions.close')}>
          <XIcon className="size-3.5" />
        </Button>
      </div>

      <div className="relative mt-2">
        <IconInput
          icon={<ScanIcon className="size-3.5" />}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setScanError(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              handleScanSubmit()
            }
          }}
          placeholder={t('orders.itemsEditor.search.placeholder')}
          autoFocus
          className="!rounded-lg !text-xs"
        />
      </div>
      {scanError && <p className="mt-1 text-[11px] font-medium text-red-600">{scanError}</p>}

      <div className="mt-2 max-h-64 divide-y divide-brand-100 overflow-y-auto rounded-lg border border-brand-100 bg-white">
        {results.length === 0 && <p className="px-3 py-4 text-center text-xs text-brand-400">{t('orders.itemsEditor.noProductResults')}</p>}
        {results.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => addProductLine(p)}
            className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-accent-50"
          >
            <ProductImage src={p.images[0] ? getProductImageUrl(p.images[0].storage_path) : null} name={p.name} className="size-9 shrink-0 rounded-lg" iconSize={16} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium text-brand-800">{p.name}</span>
              <span className="block truncate text-xs text-brand-400">{p.sku ? `SKU: ${p.sku}` : '—'}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  )

  if (items.length === 0 && !searchOpen) {
    return (
      <div>
        <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-brand-200 py-12 text-center">
          <PackageIcon className="size-8 text-brand-300" />
          <p className="text-sm font-medium text-brand-600">{t('orders.itemsEditor.empty')}</p>
          {!locked && (
            <button type="button" onClick={() => setSearchOpen(true)} className="text-xs font-medium text-accent-600 hover:underline">
              {t('orders.itemsEditor.emptyCta')}
            </button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div>
      <div>
        {items.map((item, index) => {
          const selectedProduct = item.product_id ? products.find((p) => p.id === item.product_id) : undefined
          const discountAmount = item.discount_amount ?? 0
          const lineTotal = item.quantity * item.unit_price - discountAmount
          const available = availableStock(stockRows, item.product_id, item.variant_id, item.warehouse_id)
          const isShort = shortfalls.some(
            (s) => s.productId === item.product_id && s.variantId === (item.variant_id ?? null) && s.warehouseId === item.warehouse_id,
          )
          return (
            <div key={index} className="border-b border-brand-100 py-2 last:border-b-0">
              <div className="flex flex-wrap items-start gap-2.5">
                <ProductImage src={resolveItemImage(selectedProduct, item.variant_id)} name={item.product_name || '?'} className="mt-4 size-9 shrink-0 rounded-lg" iconSize={15} fit="contain" />

                <div className="min-w-[160px] flex-1 space-y-1">
                  {item.product_id ? (
                    <>
                      <Link to={`/app/products/${item.product_id}`} className="block truncate text-sm font-medium text-brand-800 hover:underline">
                        {item.product_name}
                      </Link>
                      <p className="truncate text-xs text-brand-400">{item.sku ? `SKU: ${item.sku}` : '—'}</p>
                    </>
                  ) : (
                    <Input
                      value={item.product_name}
                      onChange={(e) => updateItem(index, { product_name: e.target.value })}
                      placeholder={t('orders.itemsEditor.lineNamePlaceholder')}
                      disabled={locked}
                    />
                  )}
                </div>

                {selectedProduct?.has_variants && (
                  <div className="w-40 shrink-0">
                    <span className="mb-0.5 block text-[11px] font-medium text-brand-400">{t('orders.itemsEditor.variant')}</span>
                    <Select value={item.variant_id ?? undefined} onValueChange={(v) => handleVariantSelect(index, selectedProduct, v)} disabled={locked}>
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder={t('orders.itemsEditor.selectVariant')} />
                      </SelectTrigger>
                      <SelectContent>
                        {selectedProduct.variants
                          .filter((v) => v.is_active)
                          .map((v) => (
                            <SelectItem key={v.id} value={v.id}>
                              {formatVariantLabel(v, selectedProduct.options)}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                <div className="w-36 shrink-0">
                  <span className="mb-0.5 block text-[11px] font-medium text-brand-400">{t('orders.itemsEditor.warehouse')}</span>
                  {item.product_id ? (
                    <>
                      <Select value={item.warehouse_id ?? undefined} onValueChange={(v) => updateItem(index, { warehouse_id: v })} disabled={locked}>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder={t('orders.itemsEditor.selectWarehouse')} />
                        </SelectTrigger>
                        <SelectContent>
                          {warehouses.map((w) => {
                            const wAvailable = availableStock(stockRows, item.product_id, item.variant_id, w.id) ?? 0
                            return (
                              <SelectItem
                                key={w.id}
                                value={w.id}
                                meta={
                                  <span className={`ml-auto shrink-0 text-[11px] ${wAvailable > 0 ? 'text-brand-400' : 'text-red-500'}`}>
                                    {t('products.table.available', { count: wAvailable })}
                                  </span>
                                }
                              >
                                {w.name}
                              </SelectItem>
                            )
                          })}
                        </SelectContent>
                      </Select>
                      {available !== null && (
                        <p className={`mt-1 text-[11px] font-medium ${available <= 0 || isShort ? 'text-red-500' : 'text-brand-400'}`}>{t('products.table.available', { count: available })}</p>
                      )}
                    </>
                  ) : (
                    <p className="mt-1.5 text-xs text-brand-300">—</p>
                  )}
                </div>

                <div className="w-20 shrink-0">
                  <span className={`mb-0.5 block text-[11px] font-medium ${isShort ? 'text-red-500' : 'text-brand-400'}`}>{t('orders.itemsEditor.quantity')}</span>
                  <Input
                    type="number"
                    min="0"
                    step="1"
                    value={item.quantity}
                    onChange={(e) => updateItem(index, { quantity: Number(e.target.value) || 0 })}
                    aria-invalid={isShort}
                    disabled={locked}
                    className={`text-right ${isShort ? 'border-red-400 text-red-700 focus-visible:ring-red-300' : ''}`}
                  />
                </div>

                <div className="w-28 shrink-0">
                  <span className="mb-0.5 block text-[11px] font-medium text-brand-400">{t('orders.itemsEditor.unitPrice')}</span>
                  <CurrencyInput value={item.unit_price} onChange={(e) => updateItem(index, { unit_price: Number(e.target.value) || 0 })} disabled={locked} className="text-right" />
                </div>

                <div className="w-28 shrink-0">
                  <span className="mb-0.5 block text-[11px] font-medium text-brand-400">{t('orders.itemsEditor.columns.discount')}</span>
                  <CurrencyInput value={discountAmount} onChange={(e) => updateItem(index, { discount_amount: Number(e.target.value) || 0 })} disabled={locked} className="text-right" />
                </div>

                <div className="w-28 shrink-0 text-right">
                  <span className="mb-0.5 block text-[11px] font-medium text-brand-400">{t('orders.itemsEditor.columns.total')}</span>
                  <p className="mt-1 text-sm font-semibold text-brand-800">{formatCurrency(lineTotal, currency)}</p>
                </div>

                {!locked && (
                  <Button type="button" variant="destructive" size="icon-xs" onClick={() => removeItem(index)} aria-label={t('orders.itemsEditor.removeAria')} className="mt-4 shrink-0 rounded-full">
                    <TrashIcon width={12} height={12} />
                  </Button>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Debajo de la lista, no arriba -- pedido explícito del usuario: con
          el buscador arriba, agregar un producto lo mandaba al fondo de la
          lista sin ninguna señal visible de que se agregó, sin hacer
          scroll. Acá la línea nueva aparece justo encima de donde ya está
          mirando. "Línea personalizada" vive al lado de "Agregar producto"
          (antes tenía su propia barra abajo con el subtotal, que ya se ve
          en la card de Resumen -- quitarlo de acá gana espacio). */}
      {!locked && (
        <div className={items.length > 0 ? 'mt-3' : ''}>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={addCustomLine}>
              {t('orders.itemsEditor.addLine')}
            </Button>
            <Button type="button" size="sm" onClick={() => setSearchOpen((v) => !v)}>
              <PlusIcon className="size-3.5" /> {t('orders.itemsEditor.addProduct')}
            </Button>
          </div>
          {searchPanel}
        </div>
      )}
    </div>
  )
}
