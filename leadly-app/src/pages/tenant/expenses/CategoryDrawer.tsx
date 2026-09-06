import { useEffect, useState, type FormEvent } from 'react'
import { createExpenseCategory, updateExpenseCategory } from '../../../lib/api/expenseCategories'
import type { ExpenseCategory } from '../../../types/domain'
import { useLanguage } from '../../../contexts/LanguageContext'
import { FieldError } from '@/components/atoms'
import { Drawer } from '@/components/organisms'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { isNotBlank } from '../../../lib/validation'

const FIELD_CLASS = '!h-7 !rounded-lg !text-xs'
const TEXTAREA_CLASS = '!rounded-lg !py-1.5 !text-xs'

export function CategoryDrawer({
  open,
  onClose,
  tenantId,
  category,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  tenantId: string
  category?: ExpenseCategory | null
  onSaved: () => void
}) {
  const { t } = useLanguage()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [touched, setTouched] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setName(category?.name ?? '')
    setDescription(category?.description ?? '')
    setTouched(false)
    setFormError(null)
  }, [open, category])

  const nameError = touched && !isNotBlank(name) ? t('expenses.categories.errors.nameRequired') : undefined

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    setFormError(null)
    if (!isNotBlank(name)) return

    setSubmitting(true)
    try {
      const input = { tenant_id: tenantId, name: name.trim(), description: description.trim() || null }
      if (category) await updateExpenseCategory(category.id, input)
      else await createExpenseCategory(input)
      onSaved()
      onClose()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('expenses.categories.errors.save'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={category ? t('expenses.categories.drawer.editTitle') : t('expenses.categories.drawer.newTitle')}
      description={t('expenses.categories.drawer.description')}
    >
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        <div>
          <Label htmlFor="expense-category-name">{t('expenses.categories.fields.name')}</Label>
          <Input
            id="expense-category-name"
            value={name}
            aria-invalid={!!nameError}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('expenses.categories.fields.namePlaceholder')}
            className={`mt-1 ${FIELD_CLASS}`}
          />
          <FieldError message={nameError} />
        </div>

        <div>
          <Label htmlFor="expense-category-description">{t('expenses.categories.fields.description')}</Label>
          <Textarea
            id="expense-category-description"
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className={`mt-1 ${TEXTAREA_CLASS}`}
          />
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
