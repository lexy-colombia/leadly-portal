import { useEffect, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { getProduct, getProductImageUrl } from '../../lib/api/products'
import type { ProductDetail } from '../../lib/api/products'
import { Badge, PageSpinner } from '../../components/ui'
import { BoxIcon, ChevronLeftIcon, MailIcon, PencilIcon, PhoneIcon, UserIcon } from '../../components/icons'
import { ProductDrawer } from './products/ProductDrawer'
import { useAuth } from '../../contexts/AuthContext'

function formatCurrency(value: number | null, currency: string): string {
  if (value == null) return '-'
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value)
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('es-CO', { day: '2-digit', month: 'long', year: 'numeric' })
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
  const [product, setProduct] = useState<ProductDetail | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [editOpen, setEditOpen] = useState(false)

  function reload() {
    if (!id) return
    getProduct(id)
      .then(setProduct)
      .catch((err) => setError(err.message ?? 'No se pudo cargar el producto.'))
  }

  useEffect(reload, [id])

  if (error) return <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
  if (product === undefined) return <PageSpinner />
  if (product === null) {
    return (
      <div className="space-y-4">
        <p className="text-brand-500">No encontramos este producto.</p>
        <Link to="/app/productos" className="text-sm font-medium text-accent-600 hover:text-accent-700">
          Volver a Productos
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
        <ChevronLeftIcon width={14} height={14} /> Productos
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
                <Badge tone={product.is_active ? 'success' : 'neutral'}>{product.is_active ? 'Activo' : 'Inactivo'}</Badge>
                {lowStock && <Badge tone="danger">Stock bajo</Badge>}
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
              <PencilIcon width={13} height={13} /> Editar
            </button>
          </div>

          {product.description && <p className="whitespace-pre-wrap text-sm text-brand-600">{product.description}</p>}

          <Section title="Precios">
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Field label="Compra" value={formatCurrency(product.purchase_price, product.currency)} />
              <Field label="Mayorista" value={formatCurrency(product.wholesale_price, product.currency)} />
              <Field label="Público" value={formatCurrency(product.retail_price, product.currency)} />
              <Field label="Margen" value={margin != null ? `${formatCurrency(margin, product.currency)} (${marginPct?.toFixed(0)}%)` : '-'} />
            </dl>
          </Section>

          <Section title="Inventario">
            {product.track_inventory ? (
              <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Field label="Stock total" value={product.stock_quantity} />
                <Field label="Reservado" value={product.reserved_stock} />
                <Field label="Disponible" value={<span className={lowStock ? 'font-semibold text-red-600' : ''}>{available}</span>} />
                <Field label="Alerta bajo" value={product.low_stock_threshold} />
              </dl>
            ) : (
              <p className="text-sm text-brand-400">Este producto no controla inventario.</p>
            )}
          </Section>

          {product.supplier && (
            <Section title="Proveedor">
              <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                <Field label="Nombre" value={product.supplier.name} />
                {product.supplier.contact_name && (
                  <Field label="Contacto" value={<span className="inline-flex items-center gap-1"><UserIcon width={12} height={12} />{product.supplier.contact_name}</span>} />
                )}
                {product.supplier.phone && (
                  <Field label="Teléfono" value={<span className="inline-flex items-center gap-1"><PhoneIcon width={12} height={12} />{product.supplier.phone}</span>} />
                )}
                {product.supplier.email && (
                  <Field label="Correo" value={<span className="inline-flex items-center gap-1"><MailIcon width={12} height={12} />{product.supplier.email}</span>} />
                )}
              </dl>
            </Section>
          )}

          <Section title="Detalles">
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              <Field label="Slug" value={product.slug ?? '-'} />
              <Field label="Moneda" value={product.currency} />
              <Field label="Creado" value={formatDate(product.created_at)} />
              <Field label="Actualizado" value={formatDate(product.updated_at)} />
            </dl>
          </Section>
        </div>
      </div>

      {profile?.tenant_id && (
        <ProductDrawer open={editOpen} onClose={() => setEditOpen(false)} tenantId={profile.tenant_id} product={product} onSaved={reload} />
      )}
    </div>
  )
}
