import { useEffect, useState, type FormEvent } from 'react'
import { MOVEMENT_TYPE_KEY, recordStockMovement } from '../../../lib/api/stockMovements'
import { listWarehouses } from '../../../lib/api/warehouses'
import type { StockMovementType, Warehouse } from '../../../types/domain'
import { useLanguage } from '../../../contexts/LanguageContext'
import { Button, Drawer, FieldError, Input, Label, Select, Textarea } from '../../../components/ui'

const MOVEMENT_TYPES: StockMovementType[] = ['entrada', 'salida', 'ajuste_positivo', 'ajuste_negativo']

export function StockMovementDrawer({
  open,
  onClose,
  tenantId,
  productId,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  tenantId: string
  productId: string
  onSaved: () => void
}) {
  const { t } = useLanguage()
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [warehouseId, setWarehouseId] = useState('')
  const [movementType, setMovementType] = useState<StockMovementType>('entrada')
  const [quantity, setQuantity] = useState('')
  const [notes, setNotes] = useState('')
  const [touched, setTouched] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setMovementType('entrada')
    setQuantity('')
    setNotes('')
    setTouched(false)
    setFormError(null)
    listWarehouses(tenantId)
      .then((list) => {
        setWarehouses(list)
        setWarehouseId((prev) => prev || list.find((w) => w.is_default)?.id || list[0]?.id || '')
      })
      .catch(() => setWarehouses([]))
  }, [open, tenantId])

  const quantityNumber = Number(quantity)
  const quantityError = touched && (!quantity || !(quantityNumber > 0)) ? t('inventory.movementDrawer.field.quantityRequired') : undefined

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    setFormError(null)
    if (!warehouseId || !(quantityNumber > 0)) return

    setSubmitting(true)
    try {
      await recordStockMovement({
        tenant_id: tenantId,
        product_id: productId,
        warehouse_id: warehouseId,
        movement_type: movementType,
        quantity: quantityNumber,
        notes: notes.trim() || null,
      })
      onSaved()
      onClose()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('inventory.movementDrawer.errors.save'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Drawer open={open} onClose={onClose} title={t('inventory.movementDrawer.title')} description={t('inventory.movementDrawer.description')}>
      {warehouses.length === 0 ? (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700">{t('inventory.movementDrawer.errors.noWarehouses')}</p>
      ) : (
        <form onSubmit={handleSubmit} noValidate className="space-y-4">
          <div>
            <Label htmlFor="movement-warehouse">{t('inventory.movementDrawer.field.warehouse')}</Label>
            <Select id="movement-warehouse" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
          </div>

          <div>
            <Label htmlFor="movement-type">{t('inventory.movementDrawer.field.type')}</Label>
            <Select id="movement-type" value={movementType} onChange={(e) => setMovementType(e.target.value as StockMovementType)}>
              {MOVEMENT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {t(MOVEMENT_TYPE_KEY[type])}
                </option>
              ))}
            </Select>
          </div>

          <div>
            <Label htmlFor="movement-quantity">{t('inventory.movementDrawer.field.quantity')}</Label>
            <Input id="movement-quantity" type="number" min="0" step="any" value={quantity} invalid={!!quantityError} onChange={(e) => setQuantity(e.target.value)} />
            <FieldError message={quantityError} />
          </div>

          <div>
            <Label htmlFor="movement-notes">{t('inventory.movementDrawer.field.notes')}</Label>
            <Textarea id="movement-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={t('inventory.movementDrawer.field.notesPlaceholder')} />
          </div>

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
      )}
    </Drawer>
  )
}
