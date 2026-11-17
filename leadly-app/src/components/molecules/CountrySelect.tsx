import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useLanguage } from '../../contexts/LanguageContext'
import { COUNTRIES } from '../../lib/referenceData'

const FIELD_CLASS = '!h-7 !rounded-lg !text-xs'

/** País por código ISO (11 habilitados + el que ya tuviera guardado). El
 * valor es el código; `onChange('')` = sin país. */
export function CountrySelect({
  value,
  onChange,
  label,
  idPrefix = 'country',
  disabled = false,
  noneLabel,
}: {
  value: string
  onChange: (code: string) => void
  label: string
  idPrefix?: string
  disabled?: boolean
  noneLabel: string
}) {
  const { language, t } = useLanguage()
  const options = COUNTRIES.filter(({ code }) => code !== 'OT')
  const current = options.find(({ code }) => code === value)
  const extraName =
    value && !current
      ? /^[A-Z]{2}$/.test(value)
        ? (new Intl.DisplayNames([language], { type: 'region' }).of(value) ?? value)
        : value
      : null
  return (
    <div>
      <Label htmlFor={`${idPrefix}-country`}>{label}</Label>
      <Select
        disabled={disabled}
        value={value || 'none'}
        onValueChange={(next) => {
          const code = next === 'none' ? '' : next
          if (code !== value) onChange(code)
        }}
      >
        <SelectTrigger id={`${idPrefix}-country`} className={`mt-1 w-full ${FIELD_CLASS}`}>
          <SelectValue>{current ? t(current.labelKey) : (extraName ?? noneLabel)}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">{noneLabel}</SelectItem>
          {extraName && <SelectItem value={value}>{extraName}</SelectItem>}
          {options.map(({ code, labelKey }) => (
            <SelectItem key={code} value={code}>
              {t(labelKey)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
