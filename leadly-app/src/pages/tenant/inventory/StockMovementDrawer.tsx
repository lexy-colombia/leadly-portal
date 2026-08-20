import { useEffect, useState, type FormEvent } from 'react'
import { ArrowRightIcon } from 'lucide-react'
import { MOVEMENT_TYPE_KEY, recordStockMovement, transferStock } from '../../../lib/api/stockMovements'
import { listWarehouses } from '../../../lib/api/warehouses'
import { formatVariantLabel, type ProductWithImages } from '../../../lib/api/products'
import type { StockMovementType, Warehouse } from '../../../types/domain'
import { useLanguage } from '../../../contexts/LanguageContext'
import { FieldError } from '@/components/atoms'
import { Drawer } from '@/components/organisms'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'

const MOVEMENT_TYPES: StockMovementType[] = ['entrada', 'salida', 'ajuste_positivo', 'ajuste_negativo']

// Mismo tamaño compacto que ProductDrawer (FIELD_CLASS/TEXTAREA_CLASS) --
// este drawer usaba los tamaños por defecto de shadcn (h-8/h-9), que se
// sienten más grandes que el resto del sistema de diseño ya establecido.
const FIELD_CLASS = '!h-7 !rounded-lg !text-xs'
const TEXTAREA_CLASS = '!rounded-lg !py-1.5 !text-xs'

type Mode = 'adjustment' | 'transfer'

export function StockMovementDrawer({
  open,
  onClose,
  tenantId,
  product,
  onSaved,
  initialMode = 'adjustment',
}: {
  open: boolean
  onClose: () => void
  tenantId: string
  product: ProductWithImages
  onSaved: () => void
  /** Lets a caller open straight into the "Traslado" tab (e.g. the
   * dedicated "Traslado de stock" CTA card on ProductDetail) instead of
   * always landing on "Ajuste" and making the user switch tabs themselves. */
  initialMode?: Mode
}) {
  const { t } = useLanguage()
  const [mode, setMode] = useState<Mode>(initialMode)
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [warehouseId, setWarehouseId] = useState('')
  const [movementType, setMovementType] = useState<StockMovementType>('entrada')
  const [fromWarehouseId, setFromWarehouseId] = useState('')
  const [toWarehouseId, setToWarehouseId] = useState('')
  const [variantId, setVariantId] = useState('')
  const [quantity, setQuantity] = useState('')
  const [notes, setNotes] = useState('')
  const [touched, setTouched] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const activeVariants = product.variants.filter((v) => v.is_active)

  useEffect(() => {
    if (!open) return
    setMode(initialMode)
    setMovementType('entrada')
    setQuantity('')
    setNotes('')
    setVariantId(activeVariants[0]?.id ?? '')
    setTouched(false)
    setFormError(null)
    listWarehouses(tenantId)
      .then((list) => {
        setWarehouses(list)
        const defaultId = list.find((w) => w.is_default)?.id || list[0]?.id || ''
        setWarehouseId(defaultId)
        setFromWarehouseId(defaultId)
        // Seeds "to" with a warehouse different from "to" whenever possible,
        // so the transfer tab never opens already pointed at the same
        // warehouse on both sides.
        setToWarehouseId(list.find((w) => w.id !== defaultId)?.id || '')
      })
      .catch(() => setWarehouses([]))
  }, [open, tenantId])

  const quantityNumber = Number(quantity)
  const quantityError = touched && (!quantity || !(quantityNumber > 0)) ? t('inventory.movementDrawer.field.quantityRequired') : undefined
  const sameWarehouseError =
    mode === 'transfer' && touched && fromWarehouseId && toWarehouseId && fromWarehouseId === toWarehouseId ? t('inventory.movementDrawer.errors.sameWarehouse') : undefined
  const variantError = touched && product.has_variants && !variantId ? t('inventory.movementDrawer.field.variantRequired') : undefined

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    setFormError(null)
    if (!(quantityNumber > 0)) return
    if (product.has_variants && !variantId) return

    if (mode === 'adjustment') {
      if (!warehouseId) return
      setSubmitting(true)
      try {
        await recordStockMovement({
          tenant_id: tenantId,
          product_id: product.id,
          warehouse_id: warehouseId,
          variant_id: product.has_variants ? variantId : null,
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
      return
    }

    if (!fromWarehouseId || !toWarehouseId || fromWarehouseId === toWarehouseId) return
    setSubmitting(true)
    try {
      await transferStock({
        tenant_id: tenantId,
        product_id: product.id,
        from_warehouse_id: fromWarehouseId,
        to_warehouse_id: toWarehouseId,
        variant_id: product.has_variants ? variantId : null,
        quantity: quantityNumber,
        notes: notes.trim() || null,
      })
      onSaved()
      onClose()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('inventory.movementDrawer.errors.transferSave'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Drawer open={open} onClose={onClose} title={t('inventory.movementDrawer.title')} description={t('inventory.movementDrawer.description')}>
      {warehouses.length === 0 ? (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700">{t('inventory.movementDrawer.errors.noWarehouses')}</p>
      ) : (
        <div className="space-y-4">
          <Tabs value={mode} onValueChange={(v) => setMode(v as Mode)}>
            <TabsList className="w-full">
              <TabsTrigger value="adjustment" className="text-xs">
                {t('inventory.movementDrawer.tabs.adjustment')}
              </TabsTrigger>
              <TabsTrigger value="transfer" disabled={warehouses.length < 2} className="text-xs">
                {t('inventory.movementDrawer.tabs.transfer')}
              </TabsTrigger>
            </TabsList>
          </Tabs>

          {mode === 'transfer' && warehouses.length < 2 && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700">{t('inventory.movementDrawer.errors.needTwoWarehouses')}</p>
          )}

          <form onSubmit={handleSubmit} noValidate className="space-y-4">
            {product.has_variants && (
              <div>
                <Label htmlFor="movement-variant">{t('inventory.movementDrawer.field.variant')}</Label>
                <Select value={variantId} onValueChange={setVariantId}>
                  <SelectTrigger id="movement-variant" aria-invalid={!!variantError} className={`mt-1 w-full ${FIELD_CLASS}`}>
                    <SelectValue placeholder={t('inventory.movementDrawer.field.variantPlaceholder')} />
                  </SelectTrigger>
                  <SelectContent>
                    {activeVariants.map((v) => (
                      <SelectItem key={v.id} value={v.id} className="text-xs">
                        {formatVariantLabel(v, product.options)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldError message={variantError} />
              </div>
            )}

            {mode === 'adjustment' ? (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="movement-warehouse">{t('inventory.movementDrawer.field.warehouse')}</Label>
                  <Select value={warehouseId} onValueChange={setWarehouseId}>
                    <SelectTrigger id="movement-warehouse" className={`mt-1 w-full ${FIELD_CLASS}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {warehouses.map((w) => (
                        <SelectItem key={w.id} value={w.id} className="text-xs">
                          {w.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label htmlFor="movement-type">{t('inventory.movementDrawer.field.type')}</Label>
                  <Select value={movementType} onValueChange={(v) => setMovementType(v as StockMovementType)}>
                    <SelectTrigger id="movement-type" className={`mt-1 w-full ${FIELD_CLASS}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {MOVEMENT_TYPES.map((type) => (
                        <SelectItem key={type} value={type} className="text-xs">
                          {t(MOVEMENT_TYPE_KEY[type])}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            ) : (
              <div>
                {/* min-w-0 en cada columna flex-1 -- sin esto, un nombre de
                    bodega largo (ej. "Bodega Zona Industrial - Palermo")
                    empuja el ancho intrínseco del Select más allá de lo que
                    le toca en el flex row (min-width:auto es el default de
                    un hijo flex) y desborda el drawer entero, no solo el
                    campo. */}
                <div className="flex items-end gap-2">
                  <div className="min-w-0 flex-1">
                    <Label htmlFor="transfer-from">{t('inventory.movementDrawer.field.fromWarehouse')}</Label>
                    <Select value={fromWarehouseId} onValueChange={setFromWarehouseId}>
                      <SelectTrigger id="transfer-from" className={`mt-1 w-full ${FIELD_CLASS}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {warehouses.map((w) => (
                          <SelectItem key={w.id} value={w.id} disabled={w.id === toWarehouseId} className="text-xs">
                            {w.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <ArrowRightIcon className="mb-2 size-4 shrink-0 text-brand-300" />
                  <div className="min-w-0 flex-1">
                    <Label htmlFor="transfer-to">{t('inventory.movementDrawer.field.toWarehouse')}</Label>
                    <Select value={toWarehouseId} onValueChange={setToWarehouseId}>
                      <SelectTrigger id="transfer-to" className={`mt-1 w-full ${FIELD_CLASS}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {warehouses.map((w) => (
                          <SelectItem key={w.id} value={w.id} disabled={w.id === fromWarehouseId} className="text-xs">
                            {w.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <FieldError message={sameWarehouseError} />
              </div>
            )}

            <div>
              <Label htmlFor="movement-quantity">{t('inventory.movementDrawer.field.quantity')}</Label>
              <Input
                id="movement-quantity"
                type="number"
                min="0"
                step="any"
                value={quantity}
                aria-invalid={!!quantityError}
                onChange={(e) => setQuantity(e.target.value)}
                className={`mt-1 ${FIELD_CLASS}`}
              />
              <FieldError message={quantityError} />
            </div>

            <div>
              <Label htmlFor="movement-notes">{t('inventory.movementDrawer.field.notes')}</Label>
              <Textarea
                id="movement-notes"
                rows={2}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder={t('inventory.movementDrawer.field.notesPlaceholder')}
                className={`mt-1 ${TEXTAREA_CLASS}`}
              />
            </div>

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
        </div>
      )}
    </Drawer>
  )
}
