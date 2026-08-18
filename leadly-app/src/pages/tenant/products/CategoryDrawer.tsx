import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { createProductCategory, descendantIds, flattenCategoryTree, updateProductCategory } from '../../../lib/api/productCategories'
import type { ProductCategory } from '../../../types/domain'
import { useLanguage } from '../../../contexts/LanguageContext'
import { FieldError } from '@/components/atoms'
import { ComboboxFilter } from '@/components/molecules'
import { Drawer } from '@/components/organisms'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { isNotBlank } from '../../../lib/validation'

const DEFAULT_COLOR = '#2FA9A5'

// Same compact sizing as ProductDrawer's FIELD_CLASS/TEXTAREA_CLASS -- every
// field in this drawer is pinned to it so it doesn't feel like a visually
// separate, bigger design system from the rest of Productos.
const FIELD_CLASS = '!h-7 !rounded-lg !text-xs'
const TEXTAREA_CLASS = '!rounded-lg !py-1.5 !text-xs'
const COMBOBOX_TRIGGER_CLASS = 'flex-1 !rounded-lg'

export function CategoryDrawer({
  open,
  onClose,
  tenantId,
  category,
  allCategories,
  defaultParentId,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  tenantId: string
  category?: ProductCategory | null
  /** Full tenant category list -- needed to build the "categoría padre"
   * picker and to exclude this category's own descendants from it (a
   * category can't become its own ancestor). */
  allCategories: ProductCategory[]
  /** Pre-selects the parent when opened via a row's "+ subcategoría" action
   * -- ignored once editing an existing category (its own parent_category_id
   * wins). */
  defaultParentId?: string | null
  onSaved: () => void
}) {
  const { t } = useLanguage()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [color, setColor] = useState(DEFAULT_COLOR)
  const [parentCategoryId, setParentCategoryId] = useState('')
  const [touched, setTouched] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setName(category?.name ?? '')
    setDescription(category?.description ?? '')
    setColor(category?.color ?? DEFAULT_COLOR)
    setParentCategoryId(category?.parent_category_id ?? defaultParentId ?? '')
    setTouched(false)
    setFormError(null)
  }, [open, category, defaultParentId])

  const parentOptions = useMemo(() => {
    const excluded = category ? descendantIds(allCategories, category.id) : new Set<string>()
    if (category) excluded.add(category.id)
    return flattenCategoryTree(allCategories)
      .filter(({ category: c }) => !excluded.has(c.id))
      .map(({ category: c, depth }) => ({ id: c.id, label: `${'—'.repeat(depth)}${depth > 0 ? ' ' : ''}${c.name}`, color: c.color }))
  }, [allCategories, category])

  const nameError = touched && !isNotBlank(name) ? t('products.categories.errors.nameRequired') : undefined

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
        description: description.trim() || null,
        color,
        parent_category_id: parentCategoryId || null,
      }
      if (category) await updateProductCategory(category.id, input)
      else await createProductCategory(input)
      onSaved()
      onClose()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('products.categories.errors.save'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={category ? t('products.categories.drawer.editTitle') : t('products.categories.drawer.newTitle')}
      description={t('products.categories.drawer.description')}
    >
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        <div className="flex gap-3">
          <div className="flex-1">
            <Label htmlFor="category-name">{t('products.categories.fields.name')}</Label>
            <Input
              id="category-name"
              value={name}
              aria-invalid={!!nameError}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('products.categories.fields.namePlaceholder')}
              className={`mt-1 ${FIELD_CLASS}`}
            />
            <FieldError message={nameError} />
          </div>
          <div>
            <Label htmlFor="category-color">{t('products.categories.fields.color')}</Label>
            <div className="mt-1 flex h-7 w-9 items-center justify-center overflow-hidden rounded-lg border border-input p-0.5">
              <input id="category-color" type="color" value={color} onChange={(e) => setColor(e.target.value)} className="h-full w-full cursor-pointer border-0 bg-transparent p-0" />
            </div>
          </div>
        </div>

        <div>
          <Label>{t('products.categories.fields.parent')}</Label>
          <div className="mt-1">
            <ComboboxFilter
              options={parentOptions}
              value={parentCategoryId || null}
              onChange={(id) => setParentCategoryId(id ?? '')}
              placeholder={t('products.categories.fields.noParent')}
              searchPlaceholder={t('products.categories.fields.searchParent')}
              emptyLabel={t('products.categories.fields.noParentResults')}
              className="w-full"
              triggerClassName={COMBOBOX_TRIGGER_CLASS}
            />
          </div>
        </div>

        <div>
          <Label htmlFor="category-description">{t('products.categories.fields.description')}</Label>
          <Textarea id="category-description" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} className={`mt-1 ${TEXTAREA_CLASS}`} />
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
    </Drawer>
  )
}
