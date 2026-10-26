import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  formatQuantity,
  isMaterialEntry,
  listMaterialMovementsPage,
  listMaterialStock,
  MATERIAL_MOVEMENT_TYPE_KEY,
  recordMaterialMovement,
  type MaterialMovementWithWarehouse,
  type MaterialStockWithWarehouse,
} from '../../../lib/api/materials'
import { listWarehouses } from '../../../lib/api/warehouses'
import type { Material, MaterialMovementType, Warehouse } from '../../../types/domain'
import { useLanguage } from '../../../contexts/LanguageContext'
import { usePermission } from '../../../contexts/AuthContext'
import { useToast } from '../../../contexts/ToastContext'
import { formatDateTime } from '../../../lib/dates'
import { FieldError, PageSpinner } from '@/components/atoms'
import { Pagination } from '@/components/molecules'
import { Drawer } from '@/components/organisms'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

const FIELD_CLASS = '!h-7 !rounded-lg !text-xs'
const MOVEMENT_TYPES: MaterialMovementType[] = ['carga_inicial', 'entrada', 'salida', 'ajuste_positivo', 'ajuste_negativo']
const MOVEMENTS_PAGE_SIZE = 10

/** Inventario de UN insumo: cantidad física por bodega, formulario de
 * ajuste/carga inicial (cantidad decimal en la unidad del insumo) y kardex
 * paginado. No valida stock: si un ajuste no procede, el backend responde. */
export function MaterialStockDrawer({
  open,
  onClose,
  tenantId,
  material,
  onSaved,
  showMovements = true,
}: {
  open: boolean
  onClose: () => void
  tenantId: string
  material: Material | null
  onSaved: () => void
  /** false en la página de detalle, que ya muestra el historial completo. */
  showMovements?: boolean
}) {
  const { t, language } = useLanguage()
  const toast = useToast()
  const canAdjust = usePermission('materials.adjust_stock')
  const [warehouses, setWarehouses] = useState<Warehouse[] | null>(null)
  const [warehousesError, setWarehousesError] = useState(false)
  const movementsReqRef = useRef(0)
  const [stock, setStock] = useState<MaterialStockWithWarehouse[] | null>(null)
  const [stockError, setStockError] = useState<string | null>(null)
  const [movements, setMovements] = useState<MaterialMovementWithWarehouse[] | null>(null)
  const [movementsCount, setMovementsCount] = useState(0)
  const [movementsPage, setMovementsPage] = useState(1)
  const [movementsError, setMovementsError] = useState<string | null>(null)

  const [warehouseId, setWarehouseId] = useState('')
  const [movementType, setMovementType] = useState<MaterialMovementType>('carga_inicial')
  const [quantity, setQuantity] = useState('')
  const [unitCost, setUnitCost] = useState('')
  const [notes, setNotes] = useState('')
  const [touched, setTouched] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const materialId = material?.id
  const unitLabel = material ? t(`materials.unit.${material.unit}`) : ''

  function loadStock() {
    if (!materialId) return
    setStockError(null)
    listMaterialStock(materialId)
      .then(setStock)
      .catch((err) => setStockError(err.message ?? t('materials.stock.errors.load')))
  }

  function loadMovements(page: number) {
    if (!materialId || !showMovements) return
    setMovementsError(null)
    const reqId = ++movementsReqRef.current
    listMaterialMovementsPage(materialId, page, MOVEMENTS_PAGE_SIZE)
      .then(({ data, count }) => {
        if (movementsReqRef.current !== reqId) return
        setMovements(data)
        setMovementsCount(count)
      })
      .catch((err) => {
        if (movementsReqRef.current === reqId) setMovementsError(err.message ?? t('materials.stock.errors.loadMovements'))
      })
  }

  // Reinicia el formulario y recarga al abrir / cambiar de insumo.
  useEffect(() => {
    if (!open || !materialId) return
    setStock(null)
    setMovements(null)
    setMovementsPage(1)
    setMovementType('carga_inicial')
    setQuantity('')
    setUnitCost('')
    setNotes('')
    setTouched(false)
    setFormError(null)
    loadStock()
    loadWarehouses()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, materialId, tenantId])

  // Un fallo al cargar las bodegas NO es "no hay bodegas": estado de error con Reintentar.
  function loadWarehouses() {
    setWarehousesError(false)
    setWarehouses(null)
    listWarehouses(tenantId)
      .then((list) => {
        setWarehouses(list)
        setWarehouseId(list.find((w) => w.is_default)?.id || list[0]?.id || '')
      })
      .catch(() => setWarehousesError(true))
  }

  useEffect(() => {
    if (!open || !showMovements) return
    loadMovements(movementsPage)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, materialId, movementsPage])

  const quantityNumber = Number(quantity)
  const quantityError = touched && (!quantity || !(quantityNumber > 0)) ? t('materials.stock.form.quantityRequired') : undefined
  const costNumber = unitCost.trim() === '' ? null : Number(unitCost)
  const costError = touched && costNumber !== null && (!Number.isFinite(costNumber) || costNumber < 0) ? t('materials.drawer.errors.numberInvalid') : undefined

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    setFormError(null)
    if (!material || !warehouseId || !(quantityNumber > 0)) return
    if (costNumber !== null && (!Number.isFinite(costNumber) || costNumber < 0)) return
    setSubmitting(true)
    try {
      await recordMaterialMovement({
        tenant_id: tenantId,
        material_id: material.id,
        warehouse_id: warehouseId,
        movement_type: movementType,
        quantity: quantityNumber,
        unit_cost: costNumber,
        notes: notes.trim() || null,
      })
      toast.success(t('materials.toast.movementSaved'))
      setQuantity('')
      setUnitCost('')
      setNotes('')
      setTouched(false)
      loadStock()
      if (movementsPage === 1) loadMovements(1)
      else setMovementsPage(1)
      onSaved()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('materials.stock.errors.save'))
    } finally {
      setSubmitting(false)
    }
  }

  const totalPages = Math.max(1, Math.ceil(movementsCount / MOVEMENTS_PAGE_SIZE))

  return (
    <Drawer open={open} onClose={onClose} title={material ? t('materials.stock.title', { name: material.name }) : ''} description={t('materials.stock.description', { unit: unitLabel })} size="lg">
      {material && (
        <div className="space-y-5">
          <section className="space-y-2">
            <h3 className="text-xs font-semibold text-brand-800">{t('materials.stock.byWarehouse')}</h3>
            {stockError && (
              <p className="flex items-center gap-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
                {stockError}
                <button type="button" className="underline" onClick={loadStock}>
                  {t('common.actions.retry')}
                </button>
              </p>
            )}
            {!stock && !stockError && <PageSpinner />}
            {stock && stock.length === 0 && <p className="text-xs text-brand-400">{t('materials.stock.empty')}</p>}
            {stock && stock.length > 0 && (
              <div className="overflow-hidden rounded-lg border border-brand-100">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('materials.stock.table.warehouse')}</TableHead>
                      <TableHead className="text-right">{t('materials.stock.table.quantity')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {stock.map((row) => (
                      <TableRow key={row.warehouse_id}>
                        <TableCell className="text-xs font-medium text-brand-800">{row.warehouse.name}</TableCell>
                        <TableCell className="text-right text-xs text-brand-700">
                          {formatQuantity(row.quantity, language)} {unitLabel}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </section>

          {canAdjust && (
            <section className="space-y-3 rounded-xl border border-brand-100 p-4">
              <h3 className="text-xs font-semibold text-brand-800">{t('materials.stock.form.title')}</h3>
              {warehousesError ? (
                <p className="flex items-center gap-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
                  {t('materials.stock.errors.loadWarehouses')}
                  <button type="button" className="underline" onClick={loadWarehouses}>
                    {t('common.actions.retry')}
                  </button>
                </p>
              ) : !warehouses ? (
                <PageSpinner />
              ) : warehouses.length === 0 ? (
                <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">{t('materials.stock.errors.noWarehouses')}</p>
              ) : (
                <form onSubmit={handleSubmit} noValidate className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label htmlFor="mm-warehouse">{t('materials.stock.form.warehouse')}</Label>
                      <Select value={warehouseId} onValueChange={setWarehouseId}>
                        <SelectTrigger id="mm-warehouse" className={`mt-1 w-full ${FIELD_CLASS}`}>
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
                      <Label htmlFor="mm-type">{t('materials.stock.form.type')}</Label>
                      <Select value={movementType} onValueChange={(v) => setMovementType(v as MaterialMovementType)}>
                        <SelectTrigger id="mm-type" className={`mt-1 w-full ${FIELD_CLASS}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {MOVEMENT_TYPES.map((type) => (
                            <SelectItem key={type} value={type} className="text-xs">
                              {t(MATERIAL_MOVEMENT_TYPE_KEY[type])}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label htmlFor="mm-quantity">{t('materials.stock.form.quantity', { unit: unitLabel })}</Label>
                      <Input id="mm-quantity" type="number" min="0" step="any" value={quantity} aria-invalid={!!quantityError} onChange={(e) => setQuantity(e.target.value)} className={`mt-1 ${FIELD_CLASS}`} />
                      <FieldError message={quantityError} />
                    </div>
                    <div>
                      <Label htmlFor="mm-cost">{t('materials.stock.form.unitCost')}</Label>
                      <Input id="mm-cost" type="number" min="0" step="any" value={unitCost} aria-invalid={!!costError} onChange={(e) => setUnitCost(e.target.value)} className={`mt-1 ${FIELD_CLASS}`} />
                      <FieldError message={costError} />
                    </div>
                  </div>
                  <div>
                    <Label htmlFor="mm-notes">{t('materials.stock.form.notes')}</Label>
                    <Textarea id="mm-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} className="mt-1 !rounded-lg !py-1.5 !text-xs" />
                  </div>
                  {formError && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{formError}</p>}
                  <Button type="submit" size="sm" disabled={submitting}>
                    {submitting ? t('common.actions.saving') : t('materials.stock.form.submit')}
                  </Button>
                </form>
              )}
            </section>
          )}

          {showMovements && (
          <section className="space-y-2">
            <h3 className="text-xs font-semibold text-brand-800">{t('materials.stock.movements')}</h3>
            {movementsError && (
              <p className="flex items-center gap-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
                {movementsError}
                <button type="button" className="underline" onClick={() => loadMovements(movementsPage)}>
                  {t('common.actions.retry')}
                </button>
              </p>
            )}
            {!movements && !movementsError && <PageSpinner />}
            {movements && movements.length === 0 && <p className="text-xs text-brand-400">{t('materials.stock.noMovements')}</p>}
            {movements && movements.length > 0 && (
              <>
                <div className="overflow-hidden rounded-lg border border-brand-100">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t('materials.stock.table.date')}</TableHead>
                        <TableHead>{t('materials.stock.table.type')}</TableHead>
                        <TableHead>{t('materials.stock.table.warehouse')}</TableHead>
                        <TableHead className="text-right">{t('materials.stock.table.quantity')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {movements.map((m) => (
                        <TableRow key={m.id}>
                          <TableCell className="text-xs text-brand-500">{formatDateTime(m.created_at, language)}</TableCell>
                          <TableCell className="text-xs text-brand-700">
                            {t(MATERIAL_MOVEMENT_TYPE_KEY[m.movement_type])}
                            {m.notes && <span className="block text-[11px] text-brand-400">{m.notes}</span>}
                          </TableCell>
                          <TableCell className="text-xs text-brand-500">{m.warehouse?.name ?? '—'}</TableCell>
                          <TableCell className={`text-right text-xs font-medium ${isMaterialEntry(m.movement_type) ? 'text-emerald-600' : 'text-red-600'}`}>
                            {isMaterialEntry(m.movement_type) ? '+' : '-'}
                            {formatQuantity(m.quantity, language)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                <Pagination page={movementsPage} totalPages={totalPages} onChange={setMovementsPage} />
              </>
            )}
          </section>
          )}
        </div>
      )}
    </Drawer>
  )
}
