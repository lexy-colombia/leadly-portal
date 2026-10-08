import type { CustomFieldDefinition } from '../../../types/domain'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useLanguage } from '../../../contexts/LanguageContext'

/** Elige qué campos personalizados se muestran como columna del listado. */
export function CustomFieldColumnsPicker({
  definitions,
  selected,
  onChange,
}: {
  definitions: CustomFieldDefinition[]
  selected: string[]
  onChange: (ids: string[]) => void
}) {
  const { t } = useLanguage()
  const count = definitions.filter((d) => selected.includes(d.id)).length

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="self-end">
          {t('contacts.customFields.columns.button')}
          {count > 0 ? ` (${count})` : ''}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 space-y-2">
        <p className="text-[11px] font-semibold tracking-wide text-brand-400 uppercase">{t('contacts.customFields.columns.title')}</p>
        {definitions.map((def) => (
          <div key={def.id} className="flex items-center gap-2">
            <Checkbox
              id={`cf-col-${def.id}`}
              checked={selected.includes(def.id)}
              onCheckedChange={(checked) => onChange(checked === true ? [...selected, def.id] : selected.filter((id) => id !== def.id))}
            />
            <Label htmlFor={`cf-col-${def.id}`} className="font-normal text-brand-700">
              {def.name}
            </Label>
          </div>
        ))}
      </PopoverContent>
    </Popover>
  )
}
