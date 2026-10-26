import { ModuleSelector } from '@/components/organisms/ModuleSelector'
import { updateModuleSelection } from '@/lib/moduleHierarchy'
import type { TranslationKey } from '../../../i18n/translations'

/** Plan edits remain local until the containing plan form is saved. */
export function PlanModuleChecklist({ groups, selected, onChange, labelFor, disabled = false }: {
  groups: { key: string; labelKey: TranslationKey; modules: string[] }[]
  selected: Set<string>
  onChange: (next: Set<string>) => void
  labelFor: (moduleKey: string) => string
  disabled?: boolean
}) {
  return <ModuleSelector moduleKeys={groups.flatMap((group) => group.modules)} selected={selected} onChange={(keys, checked) => onChange(updateModuleSelection(selected, keys, checked))} labelFor={labelFor} disabled={disabled} />
}
