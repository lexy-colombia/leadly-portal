import type { LucideIcon } from 'lucide-react'

export interface SettingsCategory {
  key: string
  label: string
  icon: LucideIcon
}

/** Secondary vertical nav for the settings panel -- purely a local view
 * switcher (no routing, no reload), same idea as a Tabs component but
 * styled as a sidebar list per the approved design. Collapses to a
 * horizontal scrollable pill row below `lg` so it still works on a phone
 * without needing a second, duplicated markup tree. */
export function SettingsCategoryNav({
  categories,
  selected,
  onSelect,
}: {
  categories: SettingsCategory[]
  selected: string
  onSelect: (key: string) => void
}) {
  return (
    <nav className="flex gap-1 overflow-x-auto rounded-xl border border-brand-100 bg-white p-1.5 lg:w-60 lg:shrink-0 lg:flex-col lg:gap-0.5 lg:overflow-visible">
      {categories.map((category) => {
        const Icon = category.icon
        const active = category.key === selected
        return (
          <button
            key={category.key}
            type="button"
            onClick={() => onSelect(category.key)}
            aria-current={active ? 'true' : undefined}
            className={`flex shrink-0 items-center gap-2 whitespace-nowrap rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors lg:shrink ${
              active ? 'bg-accent-50 text-accent-700' : 'text-brand-500 hover:bg-brand-50 hover:text-brand-700'
            }`}
          >
            <Icon className="size-4 shrink-0" />
            {category.label}
          </button>
        )
      })}
    </nav>
  )
}
