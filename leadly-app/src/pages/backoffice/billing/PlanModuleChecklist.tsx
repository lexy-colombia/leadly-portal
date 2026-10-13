import { Checkbox } from '@/components/ui/checkbox'
import { useLanguage } from '../../../contexts/LanguageContext'
import type { TranslationKey } from '../../../i18n/translations'

/** Checklist of modules grouped by area (Operación / Formalización / ...),
 * with a tri-state checkbox per group. Controlled: the caller owns the Set. */
export function PlanModuleChecklist({
  groups,
  selected,
  onChange,
  labelFor,
  disabled = false,
}: {
  groups: { key: string; labelKey: TranslationKey; modules: string[] }[]
  selected: Set<string>
  onChange: (next: Set<string>) => void
  labelFor: (moduleKey: string) => string
  disabled?: boolean
}) {
  const { t } = useLanguage()

  function toggle(keys: string[], checked: boolean) {
    const next = new Set(selected)
    for (const k of keys) {
      if (checked) next.add(k)
      else next.delete(k)
    }
    onChange(next)
  }

  return (
    <div className="space-y-3">
      {groups.map((group) => {
        const allChecked = group.modules.every((k) => selected.has(k))
        const someChecked = !allChecked && group.modules.some((k) => selected.has(k))
        return (
          <div key={group.key} className="rounded-xl border border-brand-100 p-3">
            <label className="flex items-center gap-2 text-xs font-semibold text-brand-700">
              <Checkbox
                disabled={disabled}
                checked={someChecked ? 'indeterminate' : allChecked}
                onCheckedChange={(checked) => toggle(group.modules, checked === true)}
                aria-label={t(group.labelKey)}
              />
              {t(group.labelKey)}
            </label>
            <div className="mt-2 grid grid-cols-1 gap-1.5 pl-6 sm:grid-cols-2">
              {group.modules.map((k) => (
                <label key={k} className="flex items-start gap-2 text-xs text-brand-600">
                  <Checkbox disabled={disabled} checked={selected.has(k)} onCheckedChange={(checked) => toggle([k], checked === true)} className="mt-0.5" />
                  <span>{labelFor(k)}</span>
                </label>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
