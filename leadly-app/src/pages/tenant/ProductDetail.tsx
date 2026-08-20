import { useEffect, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowRightIcon, Maximize2Icon, MoreHorizontalIcon } from 'lucide-react'
import { deleteProduct, formatCategoryHierarchy, getProduct, getProductImageUrl, updateProduct } from '../../lib/api/products'
import type { ProductDetail } from '../../lib/api/products'
import { combineTransferHistory, isStockEntry, listMovementsForProduct, listStockByProduct, MOVEMENT_TYPE_KEY } from '../../lib/api/stockMovements'
import type { MovementHistoryEntry, ProductStockWithWarehouse, StockMovementWithWarehouse } from '../../lib/api/stockMovements'
import { useLanguage } from '../../contexts/LanguageContext'
import type { Language } from '../../i18n/translations'
import { InitialsAvatar, PageSpinner, ProductImage } from '@/components/atoms'
import { MailIcon, PencilIcon, PhoneIcon, PlusIcon, UserIcon } from '@/components/atoms/icons'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { ConfirmDialog } from '@/components/organisms'
import { ProductDrawer } from './products/ProductDrawer'
import { ProductVariantsCard } from './products/ProductVariantsCard'
import { StockMovementDrawer } from './inventory/StockMovementDrawer'
import { useAuth } from '../../contexts/AuthContext'

function formatCurrency(value: number | null, currency: string): string {
  if (value == null) return '-'
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value)
}

// Numérico corto ("15/08/2026") -- pedido explícito, ni el mes en texto
// largo ("15 de agosto de 2026") ni abreviado ("15 ago 2026") era lo que se
// buscaba acá.
function formatDate(iso: string, language: Language): string {
  const locale = language === 'en' ? 'en-US' : 'es-CO'
  return new Date(iso).toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: 'numeric' })
}

/** Label-above-value field -- the one fact-display shape for the whole
 * page (pricing, inventory counts, supplier contact info, metadata alike). */
function Field({ label, value, tone = 'neutral', className = '' }: { label: string; value: ReactNode; tone?: 'neutral' | 'danger'; className?: string }) {
  return (
    <div className={`min-w-0 ${className}`}>
      <dt className="text-[11px] text-brand-400">{label}</dt>
      <dd className={`truncate text-xs font-semibold ${tone === 'danger' ? 'text-red-600' : 'text-brand-800'}`}>{value}</dd>
    </div>
  )
}

/** A real bordered/padded card -- used for every distinct block on this
 * page (Precios, Detalles, Inventario por bodega, Movimientos, Acciones
 * rápidas, Proveedor). No tabs anywhere on this page anymore: Inventario/
 * Movimientos used to be separate tabs, but a traslado is still just a
 * kind of movement (combineTransferHistory already unifies them into one
 * table), so splitting the page into tabs over that one table was pure
 * overhead, not a real distinction (explicit user call). */
function StatCard({ title, action, children, className = '' }: { title: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-brand-100 p-4 ${className}`}>
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold text-brand-800">{title}</h3>
        {action}
      </div>
      {children}
    </div>
  )
}

/** Product photo with an expand affordance -- opens the full-resolution
 * image in a new tab instead of a bespoke lightbox modal, cheapest way to
 * let someone actually see it full-size without building a new overlay
 * component for one page. Sized to roughly match the header info block
 * next to it (title/badges/meta/description/stat cards), not a full-height
 * hero column -- that mismatch is what left dead space below the photo in
 * an earlier version of this page. */
function ProductImageBlock({ product }: { product: ProductDetail }) {
  const { t } = useLanguage()
  const [selected, setSelected] = useState(0)
  const images = product.images
  const activeIndex = Math.min(selected, Math.max(images.length - 1, 0))
  const activeUrl = images[activeIndex] ? getProductImageUrl(images[activeIndex].storage_path) : null

  return (
    <div className="w-full shrink-0 sm:w-72">
      <div className="relative aspect-[4/3] w-full overflow-hidden rounded-2xl border border-brand-100 bg-brand-50">
        {activeUrl ? (
          <img src={activeUrl} alt={product.name} className="h-full w-full object-cover" />
        ) : (
          <ProductImage src={null} name={product.name} className="h-full w-full" iconSize={40} />
        )}
        {activeUrl && (
          <button
            type="button"
            onClick={() => window.open(activeUrl, '_blank', 'noopener')}
            aria-label={t('products.detail.expandImage')}
            className="absolute top-2 right-2 flex h-7 w-7 items-center justify-center rounded-lg bg-white/90 text-brand-500 shadow-sm hover:text-brand-800"
          >
            <Maximize2Icon className="size-3.5" />
          </button>
        )}
      </div>
      {images.length > 1 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {images.map((img, index) => (
            <button
              key={img.id}
              type="button"
              onClick={() => setSelected(index)}
              className={`h-10 w-10 shrink-0 overflow-hidden rounded-lg border-2 transition-colors ${index === activeIndex ? 'border-accent-500' : 'border-transparent hover:border-brand-200'}`}
            >
              <img src={getProductImageUrl(img.storage_path)} alt="" className="h-full w-full object-cover" />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** One row shape covering both plain adjustments and transfers -- a
 * transfer's "Bodega" column shows "origen → destino" and its "Tipo" reads
 * as a single "Traslado" instead of the two raw transferencia_salida/
 * entrada rows it's made of (see combineTransferHistory). */
function HistoryRow({ entry, language }: { entry: MovementHistoryEntry; language: Language }) {
  const { t } = useLanguage()
  if (entry.kind === 'transfer') {
    return (
      <TableRow>
        <TableCell className="text-xs text-brand-500">{formatDate(entry.created_at, language)}</TableCell>
        <TableCell className="text-xs text-brand-700">
          <span className="inline-flex items-center gap-1.5">
            {entry.from.warehouse.name}
            <ArrowRightIcon className="size-3 shrink-0 text-brand-300" />
            {entry.to.warehouse.name}
          </span>
        </TableCell>
        <TableCell className="text-xs text-brand-700">{t('inventory.product.history.transfer')}</TableCell>
        <TableCell className="text-right text-xs font-medium text-brand-700">{entry.from.quantity}</TableCell>
      </TableRow>
    )
  }
  const { movement } = entry
  return (
    <TableRow>
      <TableCell className="text-xs text-brand-500">{formatDate(movement.created_at, language)}</TableCell>
      <TableCell className="text-xs text-brand-500">{movement.warehouse.name}</TableCell>
      <TableCell className="text-xs text-brand-700">{t(MOVEMENT_TYPE_KEY[movement.movement_type])}</TableCell>
      <TableCell className={`text-right text-xs font-medium ${isStockEntry(movement.movement_type) ? 'text-emerald-600' : 'text-red-600'}`}>
        {t('inventory.product.movement.quantitySign', { sign: isStockEntry(movement.movement_type) ? '+' : '-', quantity: movement.quantity })}
      </TableCell>
    </TableRow>
  )
}

function HistoryTable({ entries, language }: { entries: MovementHistoryEntry[]; language: Language }) {
  const { t } = useLanguage()
  return (
    <div className="overflow-hidden rounded-lg border border-brand-100">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('inventory.product.table.date')}</TableHead>
            <TableHead>{t('inventory.product.table.warehouse')}</TableHead>
            <TableHead>{t('inventory.product.table.type')}</TableHead>
            <TableHead className="text-right">{t('inventory.product.table.quantity')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.map((entry) => (
            <HistoryRow key={entry.kind === 'transfer' ? entry.id : entry.movement.id} entry={entry} language={language} />
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

export function ProductDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { profile } = useAuth()
  const { t, language } = useLanguage()
  const [product, setProduct] = useState<ProductDetail | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  const [stockByWarehouse, setStockByWarehouse] = useState<ProductStockWithWarehouse[] | null>(null)
  const [stockError, setStockError] = useState<string | null>(null)
  const [movements, setMovements] = useState<StockMovementWithWarehouse[] | null>(null)
  const [movementsError, setMovementsError] = useState<string | null>(null)
  const [movementDrawer, setMovementDrawer] = useState<{ open: boolean; mode: 'adjustment' | 'transfer' }>({ open: false, mode: 'adjustment' })
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

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

  async function handleToggleActive() {
    if (!product) return
    const next = !product.is_active
    setProduct({ ...product, is_active: next })
    try {
      await updateProduct(product.id, { is_active: next })
    } catch {
      setProduct({ ...product, is_active: !next })
    }
  }

  async function handleDelete() {
    if (!product) return
    setDeleting(true)
    setDeleteError(null)
    try {
      await deleteProduct(product.id)
      navigate('/app/products')
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : t('products.errors.delete'))
      setDeleting(false)
    }
  }

  if (error) return <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
  if (product === undefined) return <PageSpinner />
  if (product === null) {
    return (
      <div className="space-y-4">
        <p className="text-brand-500">{t('products.detail.notFound')}</p>
        <Link to="/app/products" className="text-sm font-medium text-accent-600 hover:text-accent-700">
          {t('products.detail.backToList')}
        </Link>
      </div>
    )
  }

  // Sin stock_quantity/reserved_stock en `products` (a propósito, ver
  // types/domain.ts) -- los totales se derivan de la suma por bodega
  // (product_stock), no de un contador plano en el producto.
  const totalAvailable = stockByWarehouse?.reduce((sum, row) => sum + row.quantity, 0) ?? null
  const totalReserved = stockByWarehouse?.reduce((sum, row) => sum + row.reserved_quantity, 0) ?? null
  const totalDeparture = stockByWarehouse?.reduce((sum, row) => sum + row.departure_quantity, 0) ?? 0
  const totalDamaged = stockByWarehouse?.reduce((sum, row) => sum + row.damaged_quantity, 0) ?? 0
  const totalOverall = (totalAvailable ?? 0) + (totalReserved ?? 0) + totalDeparture + totalDamaged
  const lowStock = product.track_inventory && totalAvailable != null && totalAvailable <= product.low_stock_threshold
  const margin = product.retail_price != null && product.purchase_price != null ? product.retail_price - product.purchase_price : null
  const marginPct = margin != null && product.retail_price ? (margin / product.retail_price) * 100 : null

  const historyEntries = movements ? combineTransferHistory(movements) : null

  return (
    // No hay un "← Productos" propio acá -- el header de AppShell ya lo
    // resuelve solo para toda ruta de detalle un nivel bajo su lista
    // (resolvePageTitle/backTo), mismo patrón que ClientDetail.
    <div className="space-y-5">
      <div className="flex flex-col gap-5 sm:flex-row">
        <ProductImageBlock product={product} />

        <div className="min-w-0 flex-1 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-xl font-bold text-brand-800">{product.name}</h1>
                <Badge variant={product.is_active ? 'secondary' : 'outline'}>{t(product.is_active ? 'common.status.active' : 'common.status.inactive')}</Badge>
                {lowStock && <Badge variant="destructive">{t('products.detail.badges.lowStock')}</Badge>}
              </div>

              {/* Marca justo debajo del nombre (con su logo si tiene, mismo
                  fallback InitialsAvatar que la tabla de Marcas), categorías
                  en su propia fila abajo -- pedido explícito del usuario de
                  no mezclar todo en una sola línea de metadatos. */}
              {product.brand && (
                <div className="mt-1.5 flex items-center gap-1.5">
                  {product.brand.logo_url ? (
                    // object-contain + fondo blanco, no object-cover -- un
                    // logo tipo wordmark (lo más común) no es cuadrado, y
                    // recortarlo a un círculo lo deja irreconocible (mismo
                    // fix ya aplicado al logo del tenant en Configuracion.tsx).
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-brand-100 bg-white p-0.5">
                      <img src={product.brand.logo_url} alt="" className="h-full w-full object-contain" />
                    </span>
                  ) : (
                    <InitialsAvatar name={product.brand.name} size="xs" />
                  )}
                  <span className="text-sm font-medium text-brand-700">{product.brand.name}</span>
                </div>
              )}

              {/* SKU y categorías se movieron a la card "Información general"
                  de abajo (junto al resto de los datos del producto) --
                  antes se repetían acá arriba Y en la sección de Detalles. */}
              {product.description && <p className="mt-2 text-sm text-brand-600">{product.description}</p>}
            </div>

            <div className="flex shrink-0 items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
                <PencilIcon width={13} height={13} /> {t('common.actions.edit')}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="icon-sm" aria-label={t('products.detail.actions.moreActions')}>
                    <MoreHorizontalIcon className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  <DropdownMenuItem onSelect={handleToggleActive}>{t(product.is_active ? 'products.detail.actions.deactivate' : 'products.detail.actions.activate')}</DropdownMenuItem>
                  <DropdownMenuItem variant="destructive" onSelect={() => setDeleteOpen(true)}>
                    {t('products.detail.actions.delete')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {/* Precios + Detalles en UNA sola card con dos secciones internas
              separadas por una línea vertical, no dos cards con borde propio
              cada una (pedido explícito, referencia visual del usuario) --
              ya no "Inventario general" acá: era una simple repetición de lo
              que el cuadro de Inventario por bodega ya muestra (con su fila
              de Total general), sin agregar nada. Sin botón "Editar" propio
              -- ya existe uno en el header de la página (regla del proyecto:
              no duplicarlo, ver EmpresaDetalle.tsx). */}
          <StatCard title={t('products.detail.sections.general')}>
            {/* Grilla real (alineada), no flex-wrap -- el ancho "natural" por
                campo se veía descuadrado (pedido explícito). 4 columnas con
                los 8 campos cortos primero (2 filas completas), y los 2
                campos que de verdad pueden ser largos (Categoría/Slug) al
                final ocupando 2 columnas cada uno -- así cierran su propia
                fila completa en vez de romper la alineación de los demás. */}
            <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
              <Field label={t('products.detail.fields.purchase')} value={formatCurrency(product.purchase_price, product.currency)} />
              <Field label={t('products.detail.fields.wholesale')} value={formatCurrency(product.wholesale_price, product.currency)} />
              <Field label={t('products.detail.fields.retail')} value={<span className="text-accent-600">{formatCurrency(product.retail_price, product.currency)}</span>} />
              <Field
                label={t('products.detail.fields.margin')}
                value={
                  margin != null ? (
                    <span className={margin > 0 ? 'text-emerald-600' : margin < 0 ? 'text-red-600' : undefined}>
                      {formatCurrency(margin, product.currency)} <span className="font-normal text-brand-400">({marginPct?.toFixed(0)}%)</span>
                    </span>
                  ) : (
                    '-'
                  )
                }
              />
              <Field label={t('products.detail.fields.sku')} value={product.sku ?? '-'} />
              <Field label={t('products.detail.fields.currency')} value={product.currency} />
              <Field label={t('products.detail.fields.createdAt')} value={formatDate(product.created_at, language)} />
              <Field label={t('products.detail.fields.updatedAt')} value={formatDate(product.updated_at, language)} />
              <Field
                className="col-span-2"
                label={t('products.detail.fields.category')}
                value={product.categories.length > 0 ? formatCategoryHierarchy(product.categories) : '-'}
              />
              <Field className="col-span-2" label={t('products.detail.fields.slug')} value={product.slug ?? '-'} />
            </div>
          </StatCard>
        </div>
      </div>

      {profile?.tenant_id && (
        <StatCard title={t('products.detail.sections.variants')}>
          <ProductVariantsCard tenantId={profile.tenant_id} product={product} hasExistingStock={!product.has_variants && totalOverall > 0} onChanged={reload} />
        </StatCard>
      )}

      {product.track_inventory ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="space-y-4 lg:col-span-2">
            {/* Escondida para productos con variantes -- product_stock ya
                no tiene una fila por producto+bodega ahí, sino una por
                variante+bodega (ver 20260819061000_product_stock_variant_id.sql),
                así que esta tabla mostraría varias filas por bodega sin
                forma de saber a qué variante pertenece cada una. El stock
                por variante se ve en la card "Variantes" de arriba. */}
            {!product.has_variants && (
            <StatCard title={t('inventory.product.section.stockByWarehouse')}>
              {stockError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{stockError}</p>}
              {!stockByWarehouse && !stockError && <PageSpinner />}
              {stockByWarehouse && stockByWarehouse.length === 0 && <p className="text-xs text-brand-400">{t('inventory.product.empty.noStock')}</p>}
              {stockByWarehouse && stockByWarehouse.length > 0 && (
                <div className="overflow-hidden rounded-lg border border-brand-100">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t('inventory.product.table.warehouse')}</TableHead>
                        <TableHead className="text-right">{t('inventory.product.table.available')}</TableHead>
                        <TableHead className="text-right">{t('products.detail.fields.reserved')}</TableHead>
                        <TableHead className="text-right">{t('inventory.movementType.salida_despacho')}</TableHead>
                        <TableHead className="text-right">{t('inventory.movementType.ajuste_dano')}</TableHead>
                        <TableHead className="text-right">{t('products.detail.table.total')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {stockByWarehouse.map((row) => (
                        <TableRow key={row.id}>
                          <TableCell className="text-xs font-medium text-brand-800">{row.warehouse.name}</TableCell>
                          <TableCell className="text-right text-xs text-brand-700">{row.quantity}</TableCell>
                          <TableCell className="text-right text-xs text-brand-500">{row.reserved_quantity}</TableCell>
                          <TableCell className="text-right text-xs text-brand-500">{row.departure_quantity}</TableCell>
                          <TableCell className="text-right text-xs text-brand-500">{row.damaged_quantity}</TableCell>
                          <TableCell className="text-right text-xs font-semibold text-brand-800">
                            {row.quantity + row.reserved_quantity + row.departure_quantity + row.damaged_quantity}
                          </TableCell>
                        </TableRow>
                      ))}
                      <TableRow className="bg-brand-50/60">
                        <TableCell className="text-xs font-semibold text-brand-800">{t('products.detail.table.totalGeneral')}</TableCell>
                        <TableCell className="text-right text-xs font-semibold text-emerald-600">{totalAvailable ?? 0}</TableCell>
                        <TableCell className="text-right text-xs font-semibold text-brand-700">{totalReserved ?? 0}</TableCell>
                        <TableCell className="text-right text-xs font-semibold text-brand-700">{totalDeparture}</TableCell>
                        <TableCell className="text-right text-xs font-semibold text-red-600">{totalDamaged}</TableCell>
                        <TableCell className="text-right text-xs font-bold text-brand-800">{totalOverall}</TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                </div>
              )}
            </StatCard>
            )}

            <StatCard title={t('inventory.product.section.movements')}>
              {movementsError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{movementsError}</p>}
              {!historyEntries && !movementsError && <PageSpinner />}
              {historyEntries && historyEntries.length === 0 && <p className="text-xs text-brand-400">{t('inventory.product.empty.noMovements')}</p>}
              {historyEntries && historyEntries.length > 0 && <HistoryTable entries={historyEntries} language={language} />}
            </StatCard>
          </div>

          <div className="space-y-4">
            <StatCard title={t('products.detail.quickActions.title')}>
              <div className="space-y-2">
                <Button size="sm" className="w-full" onClick={() => setMovementDrawer({ open: true, mode: 'transfer' })}>
                  <PlusIcon width={14} height={14} /> {t('products.detail.transferCard.action')}
                </Button>
                <Button variant="outline" size="sm" className="w-full" onClick={() => setMovementDrawer({ open: true, mode: 'adjustment' })}>
                  <PlusIcon width={14} height={14} /> {t('inventory.product.actions.registerMovement')}
                </Button>
              </div>
            </StatCard>

            {product.supplier && (
              <StatCard title={t('products.detail.sections.supplier')}>
                <dl className="grid grid-cols-2 gap-3">
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
              </StatCard>
            )}
          </div>
        </div>
      ) : (
        product.supplier && (
          <StatCard title={t('products.detail.sections.supplier')} className="max-w-md">
            <dl className="grid grid-cols-2 gap-3">
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
          </StatCard>
        )
      )}

      {profile?.tenant_id && (
        <>
          <ProductDrawer open={editOpen} onClose={() => setEditOpen(false)} tenantId={profile.tenant_id} product={product} onSaved={reload} />
          <StockMovementDrawer
            open={movementDrawer.open}
            onClose={() => setMovementDrawer((prev) => ({ ...prev, open: false }))}
            tenantId={profile.tenant_id}
            product={product}
            onSaved={reloadStock}
            initialMode={movementDrawer.mode}
          />
        </>
      )}

      <ConfirmDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={handleDelete}
        title={t('products.detail.deleteConfirm.title')}
        description={t('products.detail.deleteConfirm.description')}
        confirmLabel={t('products.detail.deleteConfirm.confirmLabel')}
        loading={deleting}
        error={deleteError}
      />
    </div>
  )
}
