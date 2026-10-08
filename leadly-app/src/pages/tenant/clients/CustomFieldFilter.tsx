import type { CustomFieldDefinition } from '../../../types/domain'
import { ComboboxFilter, FilterField } from '@/components/molecules'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { operatorsFor, type CustomFieldOperator } from '../../../lib/customFieldValues'
import { useLanguage } from '../../../contexts/LanguageContext'
import type { TranslationKey } from '../../../i18n/translations'

const TRIGGER_CLASS = 'w-40 rounded-lg text-xs'

/** Filtro del listado por un campo personalizado (en memoria). Es un
 * controlado puro: el estado y su espejo en la URL viven en Clients.tsx. */
export function CustomFieldFilter({
  definitions,
  fieldId,
  operator,
  value,
  onChange,
}: {
  definitions: CustomFieldDefinition[]
  fieldId: string | null
  operator: CustomFieldOperator | null
  value: string
  onChange: (next: { fieldId: string | null; operator: CustomFieldOperator | null; value: string }) => void
}) {
  const { t } = useLanguage()
  const def = definitions.find((d) => d.id === fieldId) ?? null
  const operators = def ? operatorsFor(def.field_type) : []
  const activeOperator = def ? (operator && operators.includes(operator) ? operator : operators[0]) : null
  const opLabel = (op: CustomFieldOperator) => t(`contacts.customFields.filter.op.${op}` as TranslationKey)

  return (
    <>
      <FilterField label={t('contacts.customFields.filter.label')}>
        <ComboboxFilter
          options={definitions.map((d) => ({ id: d.id, label: d.name }))}
          value={fieldId}
          onChange={(id) => onChange({ fieldId: id, operator: null, value: '' })}
          placeholder={t('contacts.customFields.filter.field')}
          searchPlaceholder={t('contacts.customFields.filter.fieldSearch')}
          emptyLabel={t('contacts.customFields.filter.fieldEmpty')}
          triggerClassName={TRIGGER_CLASS}
        />
      </FilterField>

      {def && activeOperator && (
        <>
          {operators.length > 1 && (
            <FilterField label={opLabel(activeOperator)}>
              <Select value={activeOperator} onValueChange={(v) => onChange({ fieldId, operator: v as CustomFieldOperator, value })}>
                <SelectTrigger className="w-32 rounded-lg text-xs">
                  <SelectValue>{opLabel(activeOperator)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {operators.map((op) => (
                    <SelectItem key={op} value={op}>
                      {opLabel(op)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FilterField>
          )}
          <FilterField label={def.name}>
            {def.field_type === 'select' || def.field_type === 'boolean' ? (
              <Select value={value} onValueChange={(v) => onChange({ fieldId, operator, value: v })}>
                <SelectTrigger className={TRIGGER_CLASS}>
                  <SelectValue placeholder={t('contacts.customFields.filter.valuePlaceholder')}>
                    {value === 'true' ? t('contacts.customFields.yes') : value === 'false' ? t('contacts.customFields.no') : value || undefined}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {def.field_type === 'boolean' ? (
                    <>
                      <SelectItem value="true">{t('contacts.customFields.yes')}</SelectItem>
                      <SelectItem value="false">{t('contacts.customFields.no')}</SelectItem>
                    </>
                  ) : (
                    (def.options ?? []).map((option) => (
                      <SelectItem key={option} value={option}>
                        {option}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            ) : (
              <Input
                type={def.field_type === 'date' ? 'date' : def.field_type === 'text' ? 'text' : 'number'}
                step={def.field_type === 'decimal' ? 'any' : undefined}
                value={value}
                onChange={(e) => onChange({ fieldId, operator, value: e.target.value })}
                placeholder={t('contacts.customFields.filter.valuePlaceholder')}
                className="!h-8 w-40 !rounded-lg !text-xs"
              />
            )}
          </FilterField>
        </>
      )}
    </>
  )
}
