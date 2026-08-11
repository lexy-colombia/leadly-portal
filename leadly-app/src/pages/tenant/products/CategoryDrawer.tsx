import { useEffect, useState, type FormEvent } from 'react'
import { createProductCategory, updateProductCategory } from '../../../lib/api/productCategories'
import type { CrmProductCategory } from '../../../types/domain'
import { Button, Drawer, FieldError, Input, Label, Textarea } from '../../../components/ui'
import { isNotBlank } from '../../../lib/validation'

const DEFAULT_COLOR = '#2FA9A5'

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
  category?: CrmProductCategory | null
  onSaved: () => void
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [color, setColor] = useState(DEFAULT_COLOR)
  const [touched, setTouched] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setName(category?.name ?? '')
    setDescription(category?.description ?? '')
    setColor(category?.color ?? DEFAULT_COLOR)
    setTouched(false)
    setFormError(null)
  }, [open, category])

  const nameError = touched && !isNotBlank(name) ? 'El nombre es obligatorio.' : undefined

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    setFormError(null)
    if (!isNotBlank(name)) return

    setSubmitting(true)
    try {
      const input = { tenant_id: tenantId, name: name.trim(), description: description.trim() || null, color }
      if (category) await updateProductCategory(category.id, input)
      else await createProductCategory(input)
      onSaved()
      onClose()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'No se pudo guardar la categoría.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Drawer open={open} onClose={onClose} title={category ? 'Editar categoría' : 'Nueva categoría'} description="Agrupa tus productos por tipo.">
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        <div className="flex gap-3">
          <div className="flex-1">
            <Label htmlFor="category-name">Nombre</Label>
            <Input id="category-name" value={name} invalid={!!nameError} onChange={(e) => setName(e.target.value)} placeholder="Ej. Ropa" />
            <FieldError message={nameError} />
          </div>
          <div>
            <Label htmlFor="category-color">Color</Label>
            <input
              id="category-color"
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              className="h-[42px] w-14 cursor-pointer rounded-lg border border-brand-200 p-1"
            />
          </div>
        </div>

        <div>
          <Label htmlFor="category-description">Descripción (opcional)</Label>
          <Textarea id="category-description" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
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
