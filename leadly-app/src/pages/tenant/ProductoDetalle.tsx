import { useEffect, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { getProduct, getProductImageUrl } from '../../lib/api/products'
import type { ProductDetail } from '../../lib/api/products'
import { isStockEntry, listMovementsForProduct, listStockByProduct, MOVEMENT_TYPE_KEY } from '../../lib/api/stockMovements'
import type { ProductStockWithWarehouse, StockMovementWithWarehouse } from '../../lib/api/stockMovements'
import { useLanguage } from '../../contexts/LanguageContext'
import type { Language } from '../../i18n/translations'
import { Badge, Button, PageSpinner, Table, TBody, TD, TH, THead, TRow } from '../../components/ui'
import { BoxIcon, ChevronLeftIcon, MailIcon, PencilIcon, PhoneIcon, PlusIcon, UserIcon } from '../../components/icons'
import { ProductDrawer } from './products/ProductDrawer'
import { StockMovementDrawer } from './inventory/StockMovementDrawer'
import { useAuth } from '../../contexts/AuthContext'

function formatCurrency(value: number | null, currency: string): string {
  if (value == null) return '-'
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value)
}

function formatDate(iso: string, language: Language): string {
  const locale = language === 'en' ? 'en-US' : 'es-CO'
  return new Date(iso).toLocaleDateString(locale, { day: '2-digit', month: 'long', year: 'numeric' })
}

/** Label-above-value field, same shape ContactoDetalle uses for its data
 * sheet -- one layout for every fact about the product instead of a
 * different one per section. */
function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-brand-400">{label}</dt>
      <dd className="truncate text-sm text-brand-700">{value}</dd>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-brand-100 bg-white p-5">
      <h3 className="mb-4 text-sm font-semibold text-brand-800">{title}</h3>
      {children}
    </div>
  )
}

/** Large hero image + thumbnail strip -- the visual centerpiece of the
 * page, deliberately much bigger than the 16x16 thumbnails in the edit
 * drawer's image manager (this page is for looking at the product, that
 * one is for managing the file list). Read-only here on purpose: adding/
 * removing photos stays a job for the edit form (ProductDrawer), so there's
 * one place that owns that action instead of two. */
function ProductGallery({ product }: { product: ProductDetail }) {
  const [selected, setSelected] = useState(0)
  const images = product.images

  if (images.length === 0) {
    return (
      <div className="flex aspect-square w-full items-center justify-center rounded-2xl border border-dashed border-brand-200 bg-brand-50 text-brand-300">
        <BoxIcon width={64} height={64} />
      </div>
    )
  }

  const activeIndex = Math.min(selected, images.length - 1)

  return (
    <div>
      <div className="aspect-square w-full overflow-hidden rounded-2xl border border-brand-100 bg-brand-50">
        <img src={getProductImageUrl(images[activeIndex].storage_path)} alt={product.name} className="h-full w-full object-cover" />
      </div>
      {images.length > 1 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {images.map((img, index) => (
            <button
              key={img.id}
              type="button"
              onClick={() => setSelected(index)}
              className={`h-16 w-16 shrink-0 overflow-hidden rounded-xl border-2 transition-colors ${
                index === activeIndex ? 'border-accent-500' : 'border-transparent hover:border-brand-200'
              }`}
            >
              <img src={getProductImageUrl(img.storage_path)} alt="" className="h-full w-full object-cover" />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function ProductoDetalle() {
  const { id } = useParams<{ id: string }>()
  const { profile } = useAuth()
  const { t, language } = useLanguage()
  const [product, setProduct] = useState<ProductDetail | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  const [stockByWarehouse, setStockByWarehouse] = useState<ProductStockWithWarehouse[] | null>(null)
  const [stockError, setStockError] = useState<string | null>(null)
  const [movements, setMovements] = useState<StockMovementWithWarehouse[] | null>(null)
  const [movementsError, setMovementsError] = useState<string | null>(null)
  const [movementDrawerOpen, setMovementDrawerOpen] = useState(false)

  function reload() {
    if (!id) return
    getProduct(id)
      .then(setProduct)
      .catch((err) => setError(err.message ?? t('products.detail.loadError')))
  }

  useEffect(reload, [id])

  function reloadStock() {
    if (!id) return
    listStockByProduct(id)
      .then(setStockByWarehouse)
      .catch((err) => setStockError(err.message ?? t('inventory.product.errors.loadStock')))
    listMovementsForProduct(id)
      .then(setMovements)
      .catch((err) => setMovementsError(err.message ?? t('inventory.product.errors.loadMovements')))
  }

  useEffect(reloadStock, [id])

  if (error) return <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
  if (product === undefined) return <PageSpinner />
  if (product === null) {
    return (
      <div className="space-y-4">
        <p className="text-brand-500">{t('products.detail.notFound')}</p>
        <Link to="/app/productos" className="text-sm font-medium text-accent-600 hover:text-accent-700">
          {t('products.detail.backToList')}
        </Link>
      </div>
    )
  }

  const available = product.stock_quantity - product.reserved_stock
  const lowStock = product.track_inventory && available <= product.low_stock_threshold
  const margin = product.retail_price != null && product.purchase_price != null ? product.retail_price - product.purchase_price : null
  const marginPct = margin != null && product.retail_price ? (margin / product.retail_price) * 100 : null

  return (
    <div className="space-y-4">
      <Link to="/app/productos" className="inline-flex items-center gap-1 text-sm font-medium text-brand-400 hover:text-brand-700">
        <ChevronLeftIcon width={14} height={14} /> {t('products.tabs.products')}
      </Link>

      <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
        <div className="lg:w-96 lg:shrink-0">
          <ProductGallery product={product} />
        </div>

        <div className="min-w-0 flex-1 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-xl font-bold text-brand-800">{product.name}</h1>
                <Badge tone={product.is_active ? 'success' : 'neutral'}>{t(product.is_active ? 'common.status.active' : 'common.status.inactive')}</Badge>
                {lowStock && <Badge tone="danger">{t('products.detail.badges.lowStock')}</Badge>}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-brand-400">
                {product.sku && <span>SKU: {product.sku}</span>}
                {product.category && (
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: product.category.color ?? '#94A3B8' }} />
                    {product.category.name}
                  </span>
                )}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setEditOpen(true)}
              className="flex shrink-0 items-center gap-1.5 rounded-lg border border-brand-200 px-3 py-1.5 text-xs font-medium text-brand-600 transition-colors hover:bg-brand-50"
            >
              <PencilIcon width={13} height={13} /> {t('common.actions.edit')}
            </button>
          </div>

          {product.description && <p className="whitespace-pre-wrap text-sm text-brand-600">{product.description}</p>}

          <Section title={t('products.detail.sections.pricing')}>
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Field label={t('products.detail.fields.purchase')} value={formatCurrency(product.purchase_price, product.currency)} />
              <Field label={t('products.detail.fields.wholesale')} value={formatCurrency(product.wholesale_price, product.currency)} />
              <Field label={t('products.detail.fields.retail')} value={formatCurrency(product.retail_price, product.currency)} />
              <Field label={t('products.detail.fields.margin')} value={margin != null ? `${formatCurrency(margin, product.currency)} (${marginPct?.toFixed(0)}%)` : '-'} />
            </dl>
          </Section>

          <Section title={t('products.detail.sections.inventory')}>
            {product.track_inventory ? (
              <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Field label={t('products.detail.fields.totalStock')} value={product.stock_quantity} />
                <Field label={t('products.detail.fields.reserved')} value={product.reserved_stock} />
                <Field label={t('products.detail.fields.available')} value={<span className={lowStock ? 'font-semibold text-red-600' : ''}>{available}</span>} />
                <Field label={t('products.detail.fields.lowStockAlert')} value={product.low_stock_threshold} />
              </dl>
            ) : (
              <p className="text-sm text-brand-400">{t('products.detail.noInventoryControl')}</p>
            )}
          </Section>

          {product.track_inventory && (
            <Section title={t('inventory.product.section.stockByWarehouse')}>
              <div className="mb-3 flex justify-end">
                <Button variant="secondary" onClick={() => setMovementDrawerOpen(true)} className="!py-1 !text-xs">
                  <PlusIcon width={14} height={14} /> {t('inventory.product.actions.registerMovement')}
                </Button>
              </div>

              {stockError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{stockError}</p>}
              {!stockByWarehouse && !stockError && <PageSpinner />}
              {stockByWarehouse && stockByWarehouse.length === 0 && <p className="text-sm text-brand-400">{t('inventory.product.empty.noStock')}</p>}

              {stockByWarehouse && stockByWarehouse.length > 0 && (
                <Table>
                  <THead>
                    <tr>
                      <TH>{t('inventory.product.table.warehouse')}</TH>
                      <TH className="text-right">{t('inventory.product.table.available')}</TH>
                      <TH className="text-right">{t('products.detail.fields.reserved')}</TH>
                      <TH className="text-right">{t('inventory.movementType.salida_despacho')}</TH>
                      <TH className="text-right">{t('inventory.movementType.ajuste_dano')}</TH>
                    </tr>
                  </THead>
                  <TBody>
                    {stockByWarehouse.map((row) => (
                      <TRow key={row.id}>
                        <TD className="text-xs font-medium text-brand-800">{row.warehouse.name}</TD>
                        <TD className="text-right text-xs text-brand-700">{row.quantity}</TD>
                        <TD className="text-right text-xs text-brand-500">{row.reserved_quantity}</TD>
                        <TD className="text-right text-xs text-brand-500">{row.departure_quantity}</TD>
                        <TD className="text-right text-xs text-brand-500">{row.damaged_quantity}</TD>
                      </TRow>
                    ))}
                  </TBody>
                </Table>
              )}

              <h4 className="mb-2 mt-5 text-xs font-semibold text-brand-600">{t('inventory.product.section.movements')}</h4>
              {movementsError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{movementsError}</p>}
              {!movements && !movementsError && <PageSpinner />}
              {movements && movements.length === 0 && <p className="text-sm text-brand-400">{t('inventory.product.empty.noMovements')}</p>}

              {movements && movements.length > 0 && (
                <Table>
                  <TBody>
                    {movements.map((movement) => (
                      <TRow key={movement.id}>
                        <TD className="text-xs text-brand-500">{formatDate(movement.created_at, language)}</TD>
                        <TD className="text-xs text-brand-500">{movement.warehouse.name}</TD>
                        <TD className="text-xs text-brand-700">{t(MOVEMENT_TYPE_KEY[movement.movement_type])}</TD>
                        <TD className={`text-right text-xs font-medium ${isStockEntry(movement.movement_type) ? 'text-emerald-600' : 'text-red-600'}`}>
                          {t('inventory.product.movement.quantitySign', { sign: isStockEntry(movement.movement_type) ? '+' : '-', quantity: movement.quantity })}
                        </TD>
                      </TRow>
                    ))}
                  </TBody>
                </Table>
              )}
            </Section>
          )}

          {product.supplier && (
            <Section title={t('products.detail.sections.supplier')}>
              <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                <Field label={t('products.detail.fields.supplierName')} value={product.supplier.name} />
                {product.supplier.contact_name && (
                  <Field
                    label={t('products.detail.fields.contactPerson')}
                    value={
                      <span className="inline-flex items-center gap-1">
                        <UserIcon width={12} height={12} />
                        {product.supplier.contact_name}
                      </span>
                    }
                  />
                )}
                {product.supplier.phone && (
                  <Field
                    label={t('products.detail.fields.phone')}
                    value={
                      <span className="inline-flex items-center gap-1">
                        <PhoneIcon width={12} height={12} />
                        {product.supplier.phone}
                      </span>
                    }
                  />
                )}
                {product.supplier.email && (
                  <Field
                    label={t('products.detail.fields.email')}
                    value={
                      <span className="inline-flex items-center gap-1">
                        <MailIcon width={12} height={12} />
                        {product.supplier.email}
                      </span>
                    }
                  />
                )}
              </dl>
            </Section>
          )}

          <Section title={t('products.detail.sections.details')}>
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              <Field label={t('products.detail.fields.slug')} value={product.slug ?? '-'} />
              <Field label={t('products.detail.fields.currency')} value={product.currency} />
              <Field label={t('products.detail.fields.createdAt')} value={formatDate(product.created_at, language)} />
              <Field label={t('products.detail.fields.updatedAt')} value={formatDate(product.updated_at, language)} />
            </dl>
          </Section>
        </div>
      </div>

      {profile?.tenant_id && (
        <>
          <ProductDrawer open={editOpen} onClose={() => setEditOpen(false)} tenantId={profile.tenant_id} product={product} onSaved={reload} />
          <StockMovementDrawer
            open={movementDrawerOpen}
            onClose={() => setMovementDrawerOpen(false)}
            tenantId={profile.tenant_id}
            productId={product.id}
            onSaved={reloadStock}
          />
        </>
      )}
    </div>
  )
}
