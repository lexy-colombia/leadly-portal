import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { createOrder, listOrderItems, updateOrder, computeOrderTotals } from '../../../lib/api/orders'
import type { OrderInput, OrderItemInput, OrderWithRelations } from '../../../lib/api/orders'
import { listContacts } from '../../../lib/api/contacts'
import { listOpportunities } from '../../../lib/api/opportunities'
import type { OpportunityWithRelations } from '../../../lib/api/opportunities'
import { listProducts } from '../../../lib/api/products'
import type { ProductWithImages } from '../../../lib/api/products'
import { listAddressesForContact } from '../../../lib/api/addresses'
import { listTasksForOpportunity } from '../../../lib/api/tasks'
import type { TaskWithRelations } from '../../../lib/api/tasks'
import type { CrmContact, CrmContactAddress, OrderStatus } from '../../../types/domain'
import { Button, CurrencyInput, Drawer, FieldError, Input, Label, Select, Textarea } from '../../../components/ui'
import { OrderItemsEditor } from './OrderItemsEditor'
import { isNotBlank } from '../../../lib/validation'

function addressLabel(a: CrmContactAddress): string {
  return `${a.label ? `${a.label} — ` : ''}${a.line1}${a.city ? `, ${a.city}` : ''}`
}

const STATUS_LABEL: Record<OrderStatus, string> = {
  cotizacion: 'Cotización',
  confirmada: 'Confirmada',
  en_proceso: 'En proceso',
  entregada: 'Entregada',
  cancelada: 'Cancelada',
}

/** No reverse transitions -- once a cotización becomes a venta it can't go
 * back (the stock-effect trigger only knows forward moves, see
 * 20260809000001_order_stock_effects.sql), and 'cancelada' is terminal.
 * A brand new order can start directly at any non-cancelada status (an
 * instant/walk-in sale skips the quote phase entirely). */
function availableStatusOptions(currentStatus: OrderStatus | null): OrderStatus[] {
  if (!currentStatus || currentStatus === 'cotizacion') return ['cotizacion', 'confirmada', 'en_proceso', 'entregada', 'cancelada']
  if (currentStatus === 'cancelada') return ['cancelada']
  return ['confirmada', 'en_proceso', 'entregada', 'cancelada']
}

function formatCurrency(value: number, currency: string): string {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value)
}

export function OrderDrawer({
  open,
  onClose,
  tenantId,
  order,
  defaultContactId,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  tenantId: string
  /** Present when editing an existing order; omitted when creating a new one. */
  order?: OrderWithRelations | null
  /** Pre-selects and locks the contact when creating from ContactoDetalle.tsx -- ignored once `order` is set (its own contact wins). */
  defaultContactId?: string | null
  onSaved: () => void
}) {
  const [contactId, setContactId] = useState('')
  const [opportunityId, setOpportunityId] = useState('')
  const [status, setStatus] = useState<OrderStatus>('cotizacion')
  const [validUntil, setValidUntil] = useState('')
  const [notes, setNotes] = useState('')
  const [shipping, setShipping] = useState('0')
  const [taxTotal, setTaxTotal] = useState('0')
  const [shippingAddressId, setShippingAddressId] = useState('')
  const [billingAddressId, setBillingAddressId] = useState('')
  const [items, setItems] = useState<OrderItemInput[]>([])
  const [contacts, setContacts] = useState<CrmContact[]>([])
  const [opportunities, setOpportunities] = useState<OpportunityWithRelations[]>([])
  const [products, setProducts] = useState<ProductWithImages[]>([])
  const [addresses, setAddresses] = useState<CrmContactAddress[]>([])
  const [relatedTasks, setRelatedTasks] = useState<TaskWithRelations[] | null>(null)
  const [touched, setTouched] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setContactId(order?.contact_id ?? defaultContactId ?? '')
    setOpportunityId(order?.opportunity_id ?? '')
    setStatus(order?.status ?? 'cotizacion')
    setValidUntil(order?.valid_until ?? '')
    setNotes(order?.notes ?? '')
    setShipping(order ? String(order.shipping) : '0')
    setTaxTotal(order ? String(order.tax_total) : '0')
    setShippingAddressId(order?.shipping_address_id ?? '')
    setBillingAddressId(order?.billing_address_id ?? '')
    setTouched(false)
    setFormError(null)
    if (order) listOrderItems(order.id).then(setItems).catch(() => setItems([]))
    else setItems([])

    setRelatedTasks(null)
    if (order?.opportunity_id) listTasksForOpportunity(order.opportunity_id).then(setRelatedTasks).catch(() => setRelatedTasks([]))
  }, [open, order, defaultContactId])

  useEffect(() => {
    if (!open) return
    listContacts(tenantId).then(setContacts).catch(() => {})
    listOpportunities(tenantId).then(setOpportunities).catch(() => {})
    listProducts(tenantId).then(setProducts).catch(() => {})
  }, [open, tenantId])

  const contactOpportunities = useMemo(() => opportunities.filter((o) => o.contact_id === contactId), [opportunities, contactId])

  useEffect(() => {
    if (opportunityId && !contactOpportunities.some((o) => o.id === opportunityId)) setOpportunityId('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactId])

  useEffect(() => {
    if (!contactId) {
      setAddresses([])
      return
    }
    listAddressesForContact(contactId).then(setAddresses).catch(() => setAddresses([]))
  }, [contactId])

  useEffect(() => {
    if (shippingAddressId && !addresses.some((a) => a.id === shippingAddressId)) setShippingAddressId('')
    if (billingAddressId && !addresses.some((a) => a.id === billingAddressId)) setBillingAddressId('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addresses])

  const contactError = touched && !isNotBlank(contactId) ? 'El contacto es obligatorio.' : undefined

  const totals = useMemo(() => computeOrderTotals(items, Number(shipping) || 0, Number(taxTotal) || 0), [items, shipping, taxTotal])

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    setFormError(null)
    if (!isNotBlank(contactId)) return

    setSubmitting(true)
    try {
      const input: OrderInput = {
        tenant_id: tenantId,
        contact_id: contactId,
        opportunity_id: opportunityId || null,
        status,
        shipping: Number(shipping) || 0,
        tax_total: Number(taxTotal) || 0,
        notes: notes.trim() || null,
        valid_until: validUntil || null,
        shipping_address_id: shippingAddressId || null,
        billing_address_id: billingAddressId || null,
      }
      const validItems = items.filter((item) => isNotBlank(item.product_name))
      if (order) await updateOrder(order.id, tenantId, input, validItems)
      else await createOrder(input, validItems)
      onSaved()
      onClose()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'No se pudo guardar.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={order ? `Editar ${order.status === 'cotizacion' ? 'cotización' : 'venta'} ORD-${order.number}` : 'Nueva cotización'}
      description="Cotizaciones y ventas son la misma entidad -- solo cambia el estado."
    >
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="order-contact">Contacto</Label>
            <Select
              id="order-contact"
              value={contactId}
              invalid={!!contactError}
              disabled={!order && !!defaultContactId}
              onChange={(e) => setContactId(e.target.value)}
            >
              <option value="">Seleccionar…</option>
              {contacts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.full_name}
                </option>
              ))}
            </Select>
            <FieldError message={contactError} />
          </div>
          <div>
            <Label htmlFor="order-status">Estado</Label>
            <Select
              id="order-status"
              value={status}
              disabled={order?.status === 'cancelada'}
              onChange={(e) => setStatus(e.target.value as OrderStatus)}
            >
              {availableStatusOptions(order?.status ?? null).map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </Select>
            {order?.status === 'cancelada' && <p className="mt-1 text-xs text-brand-400">Una orden anulada no puede reabrirse.</p>}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="order-opportunity">Oportunidad (opcional)</Label>
            <Select id="order-opportunity" value={opportunityId} onChange={(e) => setOpportunityId(e.target.value)} disabled={!contactId}>
              <option value="">Sin oportunidad</option>
              {contactOpportunities.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.title}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="order-valid-until">Válida hasta (opcional)</Label>
            <Input id="order-valid-until" type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="order-shipping-address">Dirección de envío (opcional)</Label>
            <Select id="order-shipping-address" value={shippingAddressId} onChange={(e) => setShippingAddressId(e.target.value)} disabled={!contactId}>
              <option value="">Sin dirección</option>
              {addresses
                .filter((a) => a.is_shipping)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {addressLabel(a)}
                  </option>
                ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="order-billing-address">Datos de facturación (opcional)</Label>
            <Select id="order-billing-address" value={billingAddressId} onChange={(e) => setBillingAddressId(e.target.value)} disabled={!contactId}>
              <option value="">Sin dirección</option>
              {addresses
                .filter((a) => a.is_billing)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {addressLabel(a)}
                  </option>
                ))}
            </Select>
          </div>
        </div>
        {contactId && addresses.length === 0 && (
          <p className="-mt-2 text-xs text-brand-400">Este contacto todavía no tiene direcciones guardadas -- se pueden agregar desde su ficha.</p>
        )}

        {relatedTasks && relatedTasks.length > 0 && (
          <div className="rounded-lg border border-brand-100 px-3 py-2.5">
            <p className="mb-1.5 text-xs font-medium text-brand-400">Tareas relacionadas</p>
            <ul className="space-y-1">
              {relatedTasks.map((t) => (
                <li key={t.id} className="flex items-center justify-between gap-2 text-xs text-brand-600">
                  <span className="truncate">{t.title}</span>
                  <span className="shrink-0 text-brand-400">{t.status === 'completada' ? 'Completada' : 'Pendiente'}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <OrderItemsEditor items={items} products={products} onChange={setItems} />

        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="order-shipping">Envío</Label>
            <CurrencyInput id="order-shipping" value={shipping} onChange={(e) => setShipping(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="order-tax">Impuestos</Label>
            <CurrencyInput id="order-tax" value={taxTotal} onChange={(e) => setTaxTotal(e.target.value)} />
          </div>
        </div>

        <div className="space-y-1 rounded-lg border border-brand-100 bg-brand-50/50 px-3 py-2.5 text-xs text-brand-600">
          <div className="flex justify-between">
            <span>Subtotal</span>
            <span>{formatCurrency(totals.subtotal, 'COP')}</span>
          </div>
          <div className="flex justify-between">
            <span>Descuentos</span>
            <span>-{formatCurrency(totals.discountTotal, 'COP')}</span>
          </div>
          <div className="flex justify-between font-semibold text-brand-800">
            <span>Total</span>
            <span>{formatCurrency(totals.total, 'COP')}</span>
          </div>
        </div>

        <div>
          <Label htmlFor="order-notes">Notas (opcional)</Label>
          <Textarea id="order-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>

        {formError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</p>}

        <div className="flex gap-2 border-t border-brand-100 pt-5">
          <Button type="submit" variant="secondary" disabled={submitting}>
            {submitting ? 'Guardando…' : 'Guardar'}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
        </div>
      </form>
    </Drawer>
  )
}
