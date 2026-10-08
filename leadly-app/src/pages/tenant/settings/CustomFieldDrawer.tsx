import { useEffect, useState, type FormEvent } from 'react'
import { createCustomFieldDefinition, updateCustomFieldDefinition } from '../../../lib/api/customFields'
import type { CustomFieldDefinition, CustomFieldType } from '../../../types/domain'
import { Drawer } from '@/components/organisms'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useLanguage } from '../../../contexts/LanguageContext'
import { useToast } from '../../../contexts/ToastContext'
import { CUSTOM_FIELD_TYPES, customFieldTypeKey } from './customFieldTypes'

/** Crea o edita una definición de campo personalizado de CLIENTES (la UI solo
 * ofrece esa entidad por ahora). El tipo se bloquea al editar: la base lo
 * declara inmutable. Todo error de guardado lo decide el servidor; acá solo
 * se traducen las violaciones de constraint de la tabla a un texto legible y
 * los errores del trigger (en español) se muestran tal cual. */
export function CustomFieldDrawer({
  open,
  onClose,
  tenantId,
  definition,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  tenantId: string
  definition?: CustomFieldDefinition | null
  onSaved: () => void
}) {
  const { t } = useLanguage()
  const toast = useToast()
  const [name, setName] = useState('')
  const [fieldType, setFieldType] = useState<CustomFieldType>('text')
  const [optionsText, setOptionsText] = useState('')
  const [visibleToAi, setVisibleToAi] = useState(false)
  const [displayOrder, setDisplayOrder] = useState('0')
  const [isActive, setIsActive] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setName(definition?.name ?? '')
    setFieldType(definition?.field_type ?? 'text')
    setOptionsText((definition?.options ?? []).join('\n'))
    setVisibleToAi(definition?.visible_to_ai ?? false)
    setDisplayOrder(String(definition?.display_order ?? 0))
    setIsActive(definition?.is_active ?? true)
    setFormError(null)
  }, [open, definition])

  function describeError(err: unknown): string {
    const message = err instanceof Error ? err.message : ''
    const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code?: unknown }).code) : ''
    if (code === '23505') return t('settings.customFields.errors.duplicateName')
    if (message.includes('custom_field_definitions_options_check')) return t('settings.customFields.errors.optionsRequired')
    if (message.includes('custom_field_definitions_name_check')) return t('settings.customFields.errors.nameInvalid')
    return message || t('settings.customFields.drawer.errors.saveFailed')
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setFormError(null)

    setSubmitting(true)
    try {
      const options =
        fieldType === 'select'
          ? optionsText
              .split('\n')
              .map((line) => line.trim())
              .filter((line) => line !== '')
          : null
      const common = {
        name: name.trim(),
        options,
        visible_to_ai: visibleToAi,
        display_order: Number(displayOrder) || 0,
        is_active: isActive,
      }
      if (definition) await updateCustomFieldDefinition(definition.id, common)
      else await createCustomFieldDefinition(tenantId, 'client', { ...common, field_type: fieldType })
      toast.success(t('settings.customFields.saved'))
      onSaved()
      onClose()
    } catch (err) {
      setFormError(describeError(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={definition ? t('settings.customFields.drawer.editTitle') : t('settings.customFields.drawer.newTitle')}
      description={t('settings.customFields.drawer.description')}
      size="lg"
    >
      <form onSubmit={handleSubmit} noValidate className="space-y-5">
        <div>
          <Label htmlFor="cf-name">{t('settings.customFields.drawer.fields.name')}</Label>
          <Input id="cf-name" value={name} onChange={(e) => setName(e.target.value)} className="mt-1" />
        </div>

        <div>
          <Label htmlFor="cf-type">{t('settings.customFields.drawer.fields.type')}</Label>
          <Select key={`${definition?.id ?? 'new'}-${fieldType}`} value={fieldType} onValueChange={(v) => setFieldType(v as CustomFieldType)} disabled={!!definition}>
            <SelectTrigger id="cf-type" className="mt-1 w-full">
              <SelectValue>{t(customFieldTypeKey(fieldType))}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {CUSTOM_FIELD_TYPES.map((type) => (
                <SelectItem key={type} value={type}>
                  {t(customFieldTypeKey(type))}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {definition && <p className="mt-1 text-[11px] text-brand-400">{t('settings.customFields.drawer.fields.typeLocked')}</p>}
        </div>

        {fieldType === 'select' && (
          <div>
            <Label htmlFor="cf-options">{t('settings.customFields.drawer.fields.options')}</Label>
            <Textarea id="cf-options" value={optionsText} onChange={(e) => setOptionsText(e.target.value)} rows={4} className="mt-1" />
            <p className="mt-1 text-[11px] text-brand-400">{t('settings.customFields.drawer.fields.optionsHint')}</p>
          </div>
        )}

        <div>
          <Label htmlFor="cf-order">{t('settings.customFields.drawer.fields.displayOrder')}</Label>
          <Input id="cf-order" type="number" value={displayOrder} onChange={(e) => setDisplayOrder(e.target.value)} className="mt-1 w-32" />
        </div>

        <div className="flex items-center justify-between rounded-lg border border-brand-100 px-3 py-2.5">
          <div>
            <Label htmlFor="cf-ai" className="font-normal text-brand-700">
              {t('settings.customFields.drawer.fields.visibleToAi')}
            </Label>
            <p className="mt-0.5 text-[11px] text-brand-400">{t('settings.customFields.drawer.fields.visibleToAiHint')}</p>
          </div>
          <Switch id="cf-ai" checked={visibleToAi} onCheckedChange={setVisibleToAi} />
        </div>

        <div className="flex items-center justify-between rounded-lg border border-brand-100 px-3 py-2.5">
          <Label htmlFor="cf-active" className="font-normal text-brand-700">
            {t('settings.customFields.drawer.fields.active')}
          </Label>
          <Switch id="cf-active" checked={isActive} onCheckedChange={setIsActive} />
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
