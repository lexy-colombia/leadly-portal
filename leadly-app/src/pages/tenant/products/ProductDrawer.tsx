import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  createProduct,
  deleteProductImage,
  getProductImageUrl,
  updateProduct,
  uploadProductImage,
  validateProductImageFile,
} from '../../../lib/api/products'
import type { ProductWithImages } from '../../../lib/api/products'
import { listProductCategories } from '../../../lib/api/productCategories'
import { listSuppliers } from '../../../lib/api/suppliers'
import type { CrmProductCategory, CrmSupplier } from '../../../types/domain'
import { useLanguage } from '../../../contexts/LanguageContext'
import { Button, CurrencyInput, Drawer, FieldError, Input, Label, Select, Switch, Textarea } from '../../../components/ui'
import { PlusIcon, TrashIcon } from '../../../components/icons'
import { isNotBlank } from '../../../lib/validation'

/** Images only make sense once the product exists in the DB
 * (crm_product_images.product_id needs a real row to point at) -- same
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
    <div>
      <Label>{t('products.drawer.images.label')}</Label>
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
      {uploading && <p className="mt-1 text-xs text-brand-400">{t('products.drawer.images.uploading')}</p>}
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
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
  const [slug, setSlug] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [supplierId, setSupplierId] = useState('')
  const [categories, setCategories] = useState<CrmProductCategory[]>([])
  const [suppliers, setSuppliers] = useState<CrmSupplier[]>([])
  const [purchasePrice, setPurchasePrice] = useState('')
  const [wholesalePrice, setWholesalePrice] = useState('')
  const [retailPrice, setRetailPrice] = useState('')
  const [trackInventory, setTrackInventory] = useState(true)
  const [stockQuantity, setStockQuantity] = useState('0')
  const [lowStockThreshold, setLowStockThreshold] = useState('5')
  const [isActive, setIsActive] = useState(true)
  const [touched, setTouched] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setName(product?.name ?? '')
    setDescription(product?.description ?? '')
    setSku(product?.sku ?? '')
    setSlug(product?.slug ?? '')
    setCategoryId(product?.category_id ?? '')
    setSupplierId(product?.supplier_id ?? '')
    setPurchasePrice(product?.purchase_price != null ? String(product.purchase_price) : '')
    setWholesalePrice(product?.wholesale_price != null ? String(product.wholesale_price) : '')
    setRetailPrice(product?.retail_price != null ? String(product.retail_price) : '')
    setTrackInventory(product?.track_inventory ?? true)
    setStockQuantity(product ? String(product.stock_quantity) : '0')
    setLowStockThreshold(product ? String(product.low_stock_threshold) : '5')
    setIsActive(product?.is_active ?? true)
    setTouched(false)
    setFormError(null)
  }, [open, product])

  useEffect(() => {
    if (!open) return
    listProductCategories(tenantId).then(setCategories).catch(() => {})
    listSuppliers(tenantId).then(setSuppliers).catch(() => {})
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
        slug: slug.trim() || null,
        category_id: categoryId || null,
        supplier_id: supplierId || null,
        purchase_price: toNumberOrNull(purchasePrice),
        wholesale_price: toNumberOrNull(wholesalePrice),
        retail_price: toNumberOrNull(retailPrice),
        track_inventory: trackInventory,
        stock_quantity: Math.max(0, Math.trunc(Number(stockQuantity) || 0)),
        low_stock_threshold: Math.max(0, Math.trunc(Number(lowStockThreshold) || 0)),
        is_active: isActive,
      }
      if (product) await updateProduct(product.id, input)
      else await createProduct(input)
      onSaved()
      onClose()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('products.drawer.errors.save'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={product ? t('products.drawer.editTitle') : t('products.drawer.newTitle')}
      description={t('products.drawer.description')}
    >
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        <div>
          <Label htmlFor="product-name">{t('products.drawer.fields.name')}</Label>
          <Input id="product-name" value={name} invalid={!!nameError} onChange={(e) => setName(e.target.value)} placeholder={t('products.drawer.fields.namePlaceholder')} />
          <FieldError message={nameError} />
        </div>

        <div>
          <Label htmlFor="product-description">{t('products.drawer.fields.description')}</Label>
          <Textarea id="product-description" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="product-sku">{t('products.drawer.fields.sku')}</Label>
            <Input id="product-sku" value={sku} onChange={(e) => setSku(e.target.value)} placeholder={t('products.drawer.fields.skuPlaceholder')} />
          </div>
          <div>
            <Label htmlFor="product-slug">{t('products.drawer.fields.slug')}</Label>
            <Input id="product-slug" value={slug} onChange={(e) => setSlug(e.target.value)} placeholder={t('products.drawer.fields.slugPlaceholder')} />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="product-category">{t('products.drawer.fields.category')}</Label>
            <Select id="product-category" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">{t('products.drawer.fields.noCategory')}</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="product-supplier">{t('products.drawer.fields.supplier')}</Label>
            <Select id="product-supplier" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
              <option value="">{t('products.drawer.fields.noSupplier')}</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-4">
          <div>
            <Label htmlFor="product-purchase-price">{t('products.drawer.fields.purchasePrice')}</Label>
            <CurrencyInput id="product-purchase-price" value={purchasePrice} onChange={(e) => setPurchasePrice(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="product-wholesale-price">{t('products.drawer.fields.wholesalePrice')}</Label>
            <CurrencyInput id="product-wholesale-price" value={wholesalePrice} onChange={(e) => setWholesalePrice(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="product-retail-price">{t('products.drawer.fields.retailPrice')}</Label>
            <CurrencyInput id="product-retail-price" value={retailPrice} onChange={(e) => setRetailPrice(e.target.value)} />
          </div>
        </div>

        <div className="flex items-center justify-between rounded-lg border border-brand-100 px-3 py-2.5">
          <span className="text-sm text-brand-700">{t('products.drawer.fields.trackInventory')}</span>
          <Switch checked={trackInventory} onChange={setTrackInventory} />
        </div>

        {trackInventory && (
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="product-stock">{t('products.drawer.fields.currentStock')}</Label>
              <Input id="product-stock" type="number" min="0" step="1" value={stockQuantity} onChange={(e) => setStockQuantity(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="product-low-stock">{t('products.drawer.fields.lowStockAlert')}</Label>
              <Input id="product-low-stock" type="number" min="0" step="1" value={lowStockThreshold} onChange={(e) => setLowStockThreshold(e.target.value)} />
            </div>
          </div>
        )}

        <div className="flex items-center justify-between rounded-lg border border-brand-100 px-3 py-2.5">
          <span className="text-sm text-brand-700">{t('products.drawer.fields.active')}</span>
          <Switch checked={isActive} onChange={setIsActive} />
        </div>

        {product && <ProductImages tenantId={tenantId} product={product} onChanged={onSaved} />}

        {formError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</p>}

        <div className="flex gap-2 border-t border-brand-100 pt-5">
          <Button type="submit" variant="secondary" disabled={submitting}>
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
