import type { CustomFieldDefinition } from '../../../types/domain'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useLanguage } from '../../../contexts/LanguageContext'

const FIELD_CLASS = '!h-7 !rounded-lg !text-xs'
const NONE = '__none__'

/** Un campo personalizado en el formulario, según su tipo. Solo captura el
 * valor: no compara tipos ni opciones (lo valida el servidor al guardar). */
export function CustomFieldInput({
  definition,
  value,
  onChange,
}: {
  definition: CustomFieldDefinition
  value: string | boolean | undefined
  onChange: (value: string | boolean | undefined) => void
}) {
  const { t } = useLanguage()
  const id = `custom-field-${definition.id}`

  if (definition.field_type === 'boolean') {
    return (
      <div className="flex items-center justify-between rounded-lg border border-brand-100 px-3 py-2.5">
        <Label htmlFor={id} className="font-normal text-brand-700">
          {definition.name}
        </Label>
        <Switch id={id} checked={value === true} onCheckedChange={onChange} />
      </div>
    )
  }

  return (
    <div>
      <Label htmlFor={id}>{definition.name}</Label>
      {definition.field_type === 'select' ? (
        <Select
          key={`${definition.id}-${String(value ?? '')}`}
          value={typeof value === 'string' && value !== '' ? value : NONE}
          onValueChange={(v) => onChange(v === NONE ? '' : v)}
        >
          <SelectTrigger id={id} className={`mt-1 w-full ${FIELD_CLASS}`}>
            <SelectValue>{typeof value === 'string' && value !== '' ? value : t('contacts.customFields.selectNone')}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>{t('contacts.customFields.selectNone')}</SelectItem>
            {(definition.options ?? []).map((option) => (
              <SelectItem key={option} value={option}>
                {option}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Input
          id={id}
          type={definition.field_type === 'date' ? 'date' : definition.field_type === 'text' ? 'text' : 'number'}
          step={definition.field_type === 'decimal' ? 'any' : definition.field_type === 'integer' ? '1' : undefined}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
          className={`mt-1 ${FIELD_CLASS}`}
        />
      )}
    </div>
  )
}
