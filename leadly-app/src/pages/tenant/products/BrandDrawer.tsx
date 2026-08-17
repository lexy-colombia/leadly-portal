import { useEffect, useState, type FormEvent } from 'react'
import { createBrand, updateBrand } from '../../../lib/api/brands'
import type { Brand } from '../../../types/domain'
import { useLanguage } from '../../../contexts/LanguageContext'
import { Button, FieldError, Input, Label, Switch } from '@/components/atoms'
import { Drawer } from '@/components/organisms'
import { isNotBlank } from '../../../lib/validation'

export function BrandDrawer({
  open,
  onClose,
  tenantId,
  brand,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  tenantId: string
  brand?: Brand | null
  onSaved: () => void
}) {
  const { t } = useLanguage()
  const [name, setName] = useState('')
  const [isActive, setIsActive] = useState(true)
  const [touched, setTouched] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setName(brand?.name ?? '')
    setIsActive(brand?.is_active ?? true)
    setTouched(false)
    setFormError(null)
  }, [open, brand])

  const nameError = touched && !isNotBlank(name) ? t('products.brands.errors.nameRequired') : undefined

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    setFormError(null)
    if (!isNotBlank(name)) return

    setSubmitting(true)
    try {
      const input = { tenant_id: tenantId, name: name.trim(), is_active: isActive }
      if (brand) await updateBrand(brand.id, input)
      else await createBrand(input)
      onSaved()
      onClose()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('products.brands.errors.save'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={brand ? t('products.brands.drawer.editTitle') : t('products.brands.drawer.newTitle')}
      description={t('products.brands.drawer.description')}
    >
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        <div>
          <Label htmlFor="brand-name">{t('products.brands.fields.name')}</Label>
          <Input
            id="brand-name"
            value={name}
            invalid={!!nameError}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('products.brands.fields.namePlaceholder')}
          />
          <FieldError message={nameError} />
        </div>

        <div className="flex items-center justify-between rounded-lg border border-brand-100 px-3 py-2.5">
          <span className="text-sm text-brand-700">{t('products.brands.fields.isActive')}</span>
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
