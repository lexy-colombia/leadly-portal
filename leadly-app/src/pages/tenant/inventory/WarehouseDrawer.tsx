import { useEffect, useState, type FormEvent } from 'react'
import { createWarehouse, updateWarehouse } from '../../../lib/api/warehouses'
import type { Warehouse } from '../../../types/domain'
import { useLanguage } from '../../../contexts/LanguageContext'
import { Button, Drawer, FieldError, Input, Label, Switch } from '../../../components/ui'
import { isNotBlank } from '../../../lib/validation'

export function WarehouseDrawer({
  open,
  onClose,
  tenantId,
  warehouse,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  tenantId: string
  warehouse?: Warehouse | null
  onSaved: () => void
}) {
  const { t } = useLanguage()
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [isDefault, setIsDefault] = useState(false)
  const [isActive, setIsActive] = useState(true)
  const [touched, setTouched] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setName(warehouse?.name ?? '')
    setAddress(warehouse?.address ?? '')
    setIsDefault(warehouse?.is_default ?? false)
    setIsActive(warehouse?.is_active ?? true)
    setTouched(false)
    setFormError(null)
  }, [open, warehouse])

  const nameError = touched && !isNotBlank(name) ? t('inventory.warehouseDrawer.field.nameRequired') : undefined

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
        address: address.trim() || null,
        is_default: isDefault,
        is_active: isActive,
      }
      if (warehouse) await updateWarehouse(warehouse.id, input)
      else await createWarehouse(input)
      onSaved()
      onClose()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('inventory.warehouses.errors.save'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={warehouse ? t('inventory.warehouseDrawer.editTitle') : t('inventory.warehouseDrawer.newTitle')}
      description={t('inventory.warehouseDrawer.description')}
    >
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        <div>
          <Label htmlFor="warehouse-name">{t('inventory.warehouseDrawer.field.name')}</Label>
          <Input
            id="warehouse-name"
            value={name}
            invalid={!!nameError}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('inventory.warehouseDrawer.field.namePlaceholder')}
          />
          <FieldError message={nameError} />
        </div>

        <div>
          <Label htmlFor="warehouse-address">{t('inventory.warehouseDrawer.field.address')}</Label>
          <Input id="warehouse-address" value={address} onChange={(e) => setAddress(e.target.value)} />
        </div>

        <div className="flex items-center justify-between rounded-lg border border-brand-100 px-3 py-2.5">
          <span className="text-sm text-brand-700">{t('inventory.warehouseDrawer.field.isDefault')}</span>
          <Switch checked={isDefault} onChange={setIsDefault} />
        </div>

        <div className="flex items-center justify-between rounded-lg border border-brand-100 px-3 py-2.5">
          <span className="text-sm text-brand-700">{t('inventory.warehouseDrawer.field.isActive')}</span>
          <Switch checked={isActive} onChange={setIsActive} />
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
    </Drawer>
  )
}
