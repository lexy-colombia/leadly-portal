import { useEffect, useMemo, useState } from 'react'
import { listOrders, type OrderWithRelations } from '../../../lib/api/orders'
import { createReturn, listReturnableItemsForOrder } from '../../../lib/api/returns'
import { listReturnStatuses } from '../../../lib/api/returnStatuses'
import { RETURN_REASONS, RETURN_REASON_LABEL_KEY } from '../../../lib/returnReasons'
import type { Return, ReturnReason, SalesOrderItem } from '../../../types/domain'
import { useLanguage } from '../../../contexts/LanguageContext'
import { FieldError, PageSpinner } from '@/components/atoms'
import { ComboboxFilter } from '@/components/molecules'
import { Drawer } from '@/components/organisms'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

/** Fase 1 (elegir venta) + fase 2 (elegir ítems) en un solo drawer -- una
 * devolución siempre nace de una venta confirmada existente, nunca de
 * cero. Solo ventas 'confirmada' se ofrecen (no tiene sentido devolver
 * algo que nunca se envió). */
export function ReturnCreateDrawer({ open, onClose, tenantId, onCreated }: { open: boolean; onClose: () => void; tenantId: string; onCreated: (r: Return) => void }) {
  const { t } = useLanguage()
  const [orders, setOrders] = useState<OrderWithRelations[]>([])
  const [orderId, setOrderId] = useState<string | null>(null)
  const [items, setItems] = useState<SalesOrderItem[] | null>(null)
  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(new Set())
  const [quantities, setQuantities] = useState<Record<string, string>>({})
  const [reason, setReason] = useState<ReturnReason>(RETURN_REASONS[0])
  const [notes, setNotes] = useState('')
  const [touched, setTouched] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setOrderId(null)
    setItems(null)
    setSelectedItemIds(new Set())
    setQuantities({})
    setReason(RETURN_REASONS[0])
    setNotes('')
    setTouched(false)
    setFormError(null)
    listOrders(tenantId)
      .then((all) => setOrders(all.filter((o) => o.status === 'confirmada')))
      .catch(() => setOrders([]))
  }, [open, tenantId])

  useEffect(() => {
    if (!orderId) {
      setItems(null)
      return
    }
    setItems(null)
    listReturnableItemsForOrder(orderId)
      .then((data) => {
        setItems(data)
        setSelectedItemIds(new Set())
        setQuantities(Object.fromEntries(data.map((i) => [i.id, String(i.quantity)])))
      })
      .catch(() => setItems([]))
  }, [orderId])

  const orderOptions = useMemo(
    () => orders.map((o) => ({ id: o.id, label: `#${o.number} · ${o.contact?.full_name ?? '—'}` })),
    [orders],
  )

  function toggleItem(itemId: string, checked: boolean) {
    setSelectedItemIds((prev) => {
      const next = new Set(prev)
      if (checked) next.add(itemId)
      else next.delete(itemId)
      return next
    })
  }

  const itemsError = touched && selectedItemIds.size === 0 ? t('returns.create.errors.itemsRequired') : undefined
  const orderError = touched && !orderId ? t('returns.create.errors.orderRequired') : undefined

  async function handleSubmit() {
    setTouched(true)
    setFormError(null)
    if (!orderId || selectedItemIds.size === 0) return

    setSubmitting(true)
    try {
      const statuses = await listReturnStatuses(tenantId)
      const firstStatus = statuses[0]
      const created = await createReturn({
        tenant_id: tenantId,
        sales_order_id: orderId,
        status_id: firstStatus.id,
        reason,
        notes: notes.trim() || null,
        items: Array.from(selectedItemIds).map((itemId) => ({
          sales_order_item_id: itemId,
          quantity: Number(quantities[itemId]) || 1,
        })),
      })
      onCreated(created)
      onClose()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('returns.create.errors.save'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Drawer open={open} onClose={onClose} title={t('returns.create.title')} description={t('returns.create.description')}>
      <div className="space-y-4">
        <div>
          <Label>{t('returns.create.fields.order')}</Label>
          <div className="mt-1">
            <ComboboxFilter
              options={orderOptions}
              value={orderId}
              onChange={setOrderId}
              placeholder={t('returns.create.fields.orderPlaceholder')}
              searchPlaceholder={t('returns.create.fields.orderPlaceholder')}
              emptyLabel={t('returns.empty')}
              className="w-full"
              triggerClassName="w-full"
            />
          </div>
          <FieldError message={orderError} />
        </div>

        {orderId && !items && <PageSpinner />}

        {orderId && items && items.length === 0 && <p className="text-xs text-brand-400">{t('returns.create.noItems')}</p>}

        {orderId && items && items.length > 0 && (
          <div>
            <Label>{t('returns.create.fields.items')}</Label>
            <div className="mt-1 space-y-2">
              {items.map((item) => (
                <div key={item.id} className="flex items-center gap-2 rounded-lg border border-brand-100 p-2">
                  <Checkbox checked={selectedItemIds.has(item.id)} onCheckedChange={(checked) => toggleItem(item.id, checked === true)} />
                  <span className="min-w-0 flex-1 truncate text-xs text-brand-700">{item.product_name}</span>
                  <Input
                    type="number"
                    min={1}
                    max={item.quantity}
                    disabled={!selectedItemIds.has(item.id)}
                    value={quantities[item.id] ?? String(item.quantity)}
                    onChange={(e) => setQuantities((prev) => ({ ...prev, [item.id]: e.target.value }))}
                    className="!h-7 !w-16 !rounded-lg !text-xs"
                  />
                </div>
              ))}
            </div>
            <FieldError message={itemsError} />
          </div>
        )}

        <div>
          <Label htmlFor="return-reason">{t('returns.create.fields.reason')}</Label>
          <Select value={reason} onValueChange={(v) => setReason(v as ReturnReason)}>
            <SelectTrigger id="return-reason" className="mt-1 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RETURN_REASONS.map((r) => (
                <SelectItem key={r} value={r}>
                  {t(RETURN_REASON_LABEL_KEY[r])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div>
          <Label htmlFor="return-notes">{t('returns.create.fields.notes')}</Label>
          <Textarea id="return-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} className="mt-1" />
        </div>

        {formError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</p>}

        <div className="flex gap-2 border-t border-brand-100 pt-5">
          <Button type="button" onClick={handleSubmit} disabled={submitting}>
            {submitting ? t('returns.create.actions.creating') : t('returns.create.actions.create')}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('common.actions.cancel')}
          </Button>
        </div>
      </div>
    </Drawer>
  )
}
