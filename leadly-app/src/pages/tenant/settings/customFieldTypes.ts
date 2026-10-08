import type { CustomFieldType } from '../../../types/domain'
import type { TranslationKey } from '../../../i18n/translations'

export const CUSTOM_FIELD_TYPES: CustomFieldType[] = ['text', 'integer', 'decimal', 'boolean', 'date', 'select']

export function customFieldTypeKey(type: CustomFieldType): TranslationKey {
  return `settings.customFields.type.${type}` as TranslationKey
}
