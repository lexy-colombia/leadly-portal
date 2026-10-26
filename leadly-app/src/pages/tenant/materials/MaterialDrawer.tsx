import { useEffect, useState, type FormEvent } from 'react'
import { createMaterial, MATERIAL_UNITS, materialHasHistory, updateMaterial } from '../../../lib/api/materials'
import type { Material, MaterialUnit } from '../../../types/domain'
import { useLanguage } from '../../../contexts/LanguageContext'
import { useToast } from '../../../contexts/ToastContext'
import { isNotBlank } from '../../../lib/validation'
import { FieldError } from '@/components/atoms'
import { Drawer } from '@/components/organisms'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

const FIELD_CLASS = '!h-7 !rounded-lg !text-xs'
const TEXTAREA_CLASS = '!rounded-lg !py-1.5 !text-xs'

/** Crear/editar un insumo. La unidad es una sola por insumo y no se
 * convierte entre unidades (decisión del contrato A). */
export function MaterialDrawer({
  open,
  onClose,
  tenantId,
  material,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  tenantId: string
  material: Material | null
  onSaved: () => void
}) {
  const { t } = useLanguage()
  const toast = useToast()
  const [name, setName] = useState('')
  const [sku, setSku] = useState('')
  const [unit, setUnit] = useState<MaterialUnit>('un')
  const [cost, setCost] = useState('')
  const [minStock, setMinStock] = useState('')
  const [notes, setNotes] = useState('')
  const [isActive, setIsActive] = useState(true)
  // Unidad bloqueada si el insumo ya tiene movimientos/ficha (no hay conversión)
  // y también mientras no se sabe (desconocido = bloqueado).
  const [unitLock, setUnitLock] = useState<'unknown' | 'locked' | 'free'>('free')
  const [touched, setTouched] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setName(material?.name ?? '')
    setSku(material?.sku ?? '')
    setUnit(material?.unit ?? 'un')
    setCost(material ? String(material.cost) : '')
    setMinStock(material?.min_stock != null ? String(material.min_stock) : '')
    setNotes(material?.notes ?? '')
    setIsActive(material?.is_active ?? true)
    setTouched(false)
    setFormError(null)
    if (material) {
      setUnitLock('unknown')
      let cancelled = false
      materialHasHistory(material.id)
        .then((has) => !cancelled && setUnitLock(has ? 'locked' : 'free'))
        .catch(() => !cancelled && setUnitLock('locked'))
      return () => {
        cancelled = true
      }
    }
    setUnitLock('free')
  }, [open, material])

  const nameError = touched && !isNotBlank(name) ? t('materials.drawer.errors.nameRequired') : undefined
  const costNumber = cost.trim() === '' ? 0 : Number(cost)
  const costError = touched && (!Number.isFinite(costNumber) || costNumber < 0) ? t('materials.drawer.errors.numberInvalid') : undefined
  const minNumber = minStock.trim() === '' ? null : Number(minStock)
  const minError = touched && minNumber !== null && (!Number.isFinite(minNumber) || minNumber < 0) ? t('materials.drawer.errors.numberInvalid') : undefined

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    setFormError(null)
    if (!isNotBlank(name) || !Number.isFinite(costNumber) || costNumber < 0) return
    if (minNumber !== null && (!Number.isFinite(minNumber) || minNumber < 0)) return

    setSubmitting(true)
    try {
      const input = {
        tenant_id: tenantId,
        name: name.trim(),
        sku: sku.trim() || null,
        unit,
        cost: costNumber,
        min_stock: minNumber,
        is_active: isActive,
        notes: notes.trim() || null,
      }
      if (material) await updateMaterial(material.id, input)
      else await createMaterial(input)
      toast.success(t(material ? 'materials.toast.updated' : 'materials.toast.created'))
      onSaved()
      onClose()
    } catch (err) {
      // El backend decide (p. ej. nombre repetido): se muestra su mensaje.
      setFormError(err instanceof Error ? err.message : t('materials.drawer.errors.save'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Drawer open={open} onClose={onClose} title={material ? t('materials.drawer.editTitle') : t('materials.drawer.newTitle')} description={t('materials.drawer.description')}>
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        <div>
          <Label htmlFor="material-name">{t('materials.drawer.fields.name')}</Label>
          <Input id="material-name" value={name} aria-invalid={!!nameError} onChange={(e) => setName(e.target.value)} className={`mt-1 ${FIELD_CLASS}`} />
          <FieldError message={nameError} />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="material-sku">{t('materials.drawer.fields.sku')}</Label>
            <Input id="material-sku" value={sku} onChange={(e) => setSku(e.target.value)} className={`mt-1 ${FIELD_CLASS}`} />
          </div>
          <div>
            <Label htmlFor="material-unit">{t('materials.drawer.fields.unit')}</Label>
            <Select value={unit} onValueChange={(v) => setUnit(v as MaterialUnit)} disabled={unitLock !== 'free'}>
              <SelectTrigger id="material-unit" className={`mt-1 w-full ${FIELD_CLASS}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MATERIAL_UNITS.map((u) => (
                  <SelectItem key={u} value={u} className="text-xs">
                    {t(`materials.unit.${u}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="mt-1 text-[11px] text-brand-400">{unitLock === 'free' ? t('materials.drawer.fields.unitHint') : t('materials.drawer.fields.unitLocked')}</p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="material-cost">{t('materials.drawer.fields.cost')}</Label>
            <Input id="material-cost" type="number" min="0" step="any" value={cost} aria-invalid={!!costError} onChange={(e) => setCost(e.target.value)} className={`mt-1 ${FIELD_CLASS}`} />
            <p className="mt-1 text-[11px] text-brand-400">{t('materials.drawer.fields.costHint')}</p>
            <FieldError message={costError} />
          </div>
          <div>
            <Label htmlFor="material-min">{t('materials.drawer.fields.minStock')}</Label>
            <Input id="material-min" type="number" min="0" step="any" value={minStock} aria-invalid={!!minError} onChange={(e) => setMinStock(e.target.value)} className={`mt-1 ${FIELD_CLASS}`} />
            <FieldError message={minError} />
          </div>
        </div>

        <div>
          <Label htmlFor="material-notes">{t('materials.drawer.fields.notes')}</Label>
          <Textarea id="material-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} className={`mt-1 ${TEXTAREA_CLASS}`} />
        </div>

        <div className="flex items-center justify-between rounded-lg border border-brand-100 px-3 py-2.5">
          <Label htmlFor="material-active" className="font-normal text-brand-700">
            {t('materials.drawer.fields.active')}
          </Label>
          <Switch id="material-active" checked={isActive} onCheckedChange={setIsActive} />
        </div>

        {formError && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{formError}</p>}

        <div className="flex gap-2 border-t border-brand-100 pt-4">
          <Button type="submit" disabled={submitting}>
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
