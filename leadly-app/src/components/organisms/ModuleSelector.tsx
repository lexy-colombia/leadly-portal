import { useId, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import { CRM_GROUP_ICON, TENANT_MODULES } from '@/lib/modules'
import { groupTenantModules, moduleSelectionState } from '@/lib/moduleHierarchy'
import { cn } from '@/lib/utils'
import { useLanguage } from '@/contexts/LanguageContext'

/** Shared master/detail module picker. Navigation never changes activation. */
export function ModuleSelector({ moduleKeys, selected, onChange, labelFor, disabled = false, locked = () => false, sourceLabel }: {
  moduleKeys: string[]
  selected: ReadonlySet<string>
  onChange: (keys: string[], checked: boolean) => void
  labelFor: (key: string) => string
  disabled?: boolean
  locked?: (key: string) => boolean
  sourceLabel?: (key: string) => string | undefined
}) {
  const { t } = useLanguage()
  const [activeKey, setActiveKey] = useState('products')
  const detailId = useId()
  const available = new Set(moduleKeys)
  const catalog = [
    ...TENANT_MODULES.filter((module) => available.has(module.key)),
    ...moduleKeys.filter((key) => !TENANT_MODULES.some((module) => module.key === key)).map((key) => ({ key })),
  ]
  const tree = groupTenantModules(catalog)
  const active = tree.find((node) => node.key === activeKey) ?? tree[0]
  const label = (key: string) => key === 'crm' ? t('common.nav.crm') : labelFor(key)
  const subRoutes = TENANT_MODULES.find((module) => module.key === active?.key)?.subRoutes ?? []
  const showOwnModule = !!active?.module && (active.children.length > 0 || subRoutes.length > 0)

  function control(keys: string[], name: string, onSelect?: () => void) {
    const editable = keys.filter((key) => !locked(key))
    const source = keys.length === 1 ? sourceLabel?.(keys[0]) : undefined
    return <div className="flex shrink-0 items-center gap-2">
      {source && <span className="text-[10px] text-muted-foreground">{source}</span>}
      <Checkbox aria-label={name} checked={moduleSelectionState(keys, selected)} disabled={disabled || editable.length === 0} onCheckedChange={(checked) => { onSelect?.(); onChange(editable, checked === true) }} />
    </div>
  }

  return <div className="grid overflow-hidden rounded-lg border border-border sm:grid-cols-2">
    <section className="border-b border-border sm:border-b-0 sm:border-r" aria-label={t('backoffice.clienteDetalle.modules.parents')}>
      <h3 className="border-b border-border bg-muted/40 px-3 py-2.5 text-xs font-semibold">{t('backoffice.clienteDetalle.modules.parents')}</h3>
      <div className="flex flex-col gap-0.5 p-2">
        {tree.map((node) => {
          const definition = TENANT_MODULES.find((module) => module.key === node.key)
          const hasChildren = node.children.length > 0 || !!definition?.subRoutes?.length
          const Icon = node.key === 'crm' ? CRM_GROUP_ICON : definition?.icon
          const keys = [...(node.module ? [node.key] : []), ...node.children.flatMap((child) => child.module ? [child.key] : [])]
          return <div key={node.key} className={cn('flex items-center gap-2 rounded-sm px-2', node.key === active?.key && 'bg-accent text-accent-foreground')}>
            <button type="button" aria-pressed={node.key === active?.key} aria-controls={detailId} onClick={() => setActiveKey(node.key)} className="flex min-h-8 min-w-0 flex-1 items-center gap-2 rounded-sm text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring">
              {hasChildren && Icon && <Icon width={14} height={14} />}
              <span className={cn('min-w-0 flex-1 truncate', node.key === active?.key && 'font-semibold')}>{label(node.key)}</span>
              {hasChildren && <ChevronRight size={12} className="text-muted-foreground" />}
            </button>
            {control(keys, hasChildren ? `${t('backoffice.clienteDetalle.modules.parents')}: ${label(node.key)}` : label(node.key), () => setActiveKey(node.key))}
          </div>
        })}
      </div>
    </section>
    <section id={detailId} aria-label={active ? label(active.key) : undefined}>
      <h3 className="border-b border-border bg-muted/40 px-4 py-2.5 text-xs font-semibold">{active ? label(active.key) : '—'}</h3>
      <div className="flex flex-col gap-1 p-3">
        {showOwnModule && <div className="flex min-h-8 items-center justify-between gap-3 px-1 text-xs"><span>{label(active!.key)}</span>{control([active!.key], label(active!.key))}</div>}
        {subRoutes.map((sub) => <div key={sub.to} className="flex min-h-8 items-center justify-between gap-3 px-1 text-xs"><span>{t(sub.labelKey)}</span><Checkbox aria-label={t(sub.labelKey)} title={t('backoffice.clienteDetalle.modules.includedIn', { module: label(active!.key) })} checked={selected.has(active!.key)} disabled /></div>)}
        {active?.children.map((child) => <div key={child.key} className="flex min-h-8 items-center justify-between gap-3 px-1 text-xs"><span>{label(child.key)}</span>{control([child.key], label(child.key))}</div>)}
        {subRoutes.length === 0 && !active?.children.length && <p className="px-1 py-4 text-xs leading-relaxed text-muted-foreground">{t('backoffice.clienteDetalle.modules.noChildren')}</p>}
      </div>
    </section>
  </div>
}
