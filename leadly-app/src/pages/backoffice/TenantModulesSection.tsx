import { useEffect, useState } from 'react'
import { listEnabledModuleSources, setModuleEnabled, type TenantModuleSource } from '../../lib/api/tenantModules'
import { TENANT_MODULES } from '../../lib/modules'
import { PLAN_MODULE_KEYS, moduleLabelKey } from '../../lib/planModules'
import { useAuth } from '../../contexts/AuthContext'
import { useLanguage } from '../../contexts/LanguageContext'
import { PageSpinner, Switch } from '@/components/atoms'
import { Badge } from '@/components/ui/badge'
import type { TranslationKey } from '../../i18n/translations'

const SOURCE_LABEL_KEY: Record<TenantModuleSource, TranslationKey> = {
  manual: 'backoffice.clienteDetalle.modules.source.manual',
  plan: 'backoffice.clienteDetalle.modules.source.plan',
  subscription: 'backoffice.clienteDetalle.modules.source.subscription',
}

/** Toggles apply immediately (same pattern as ai_assistant_skills' SkillsSection)
 * -- independent of any "Guardar cambios" button. A tenant with no modules
 * enabled loses access to that section of the panel entirely (nav item hidden,
 * route locked via RequireModule) -- this is where the superadmin turns them
 * back on. Each enabled module shows where it came from: 'manual' (toggled
 * here) or 'plan'/'subscription' (managed by the tenant's plan -- those are
 * visible but not togglable here, changing them is done via the plan / "Aplicar
 * plan a los módulos"). */
export function TenantModulesSection({ tenantId }: { tenantId: string }) {
  const { profile } = useAuth()
  const { t } = useLanguage()
  const [sources, setSources] = useState<Map<string, TenantModuleSource> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [togglingKey, setTogglingKey] = useState<string | null>(null)

  useEffect(() => {
    setSources(null)
    setError(null)
    listEnabledModuleSources(tenantId)
      .then(setSources)
      .catch((err) => setError(err.message ?? t('backoffice.clienteDetalle.modules.errors.load')))
  }, [tenantId, t])

  async function handleToggle(moduleKey: string, enable: boolean) {
    setTogglingKey(moduleKey)
    setError(null)
    try {
      await setModuleEnabled(tenantId, moduleKey, enable, profile?.id ?? '')
      setSources((prev) => {
        const next = new Map(prev)
        if (enable) next.set(moduleKey, 'manual')
        else next.delete(moduleKey)
        return next
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : t('backoffice.clienteDetalle.modules.errors.toggle'))
    } finally {
      setTogglingKey(null)
    }
  }

  // Catalog keys that have a DB key but no tenant-panel entry (automations)
  // still need a row so a plan-granted one is visible here.
  const rows = [
    ...TENANT_MODULES.filter((module) => !module.alwaysEnabled).map((module) => ({ key: module.key, Icon: module.icon as typeof module.icon | null })),
    ...PLAN_MODULE_KEYS.filter((key) => !TENANT_MODULES.some((m) => m.key === key)).map((key) => ({ key, Icon: null })),
  ]

  return (
    <div className="space-y-3">
      <p className="-mt-1 text-xs text-brand-400">{t('backoffice.clienteDetalle.modules.subtitle')}</p>
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
      {!sources && !error && <PageSpinner />}
      {sources && (
        <div className="grid gap-1.5 sm:grid-cols-2">
          {rows.map(({ key, Icon }) => {
            const source = sources.get(key)
            const enabled = source !== undefined
            const managed = source === 'plan' || source === 'subscription'
            const labelKey = moduleLabelKey(key)
            return (
              <div key={key} className="flex items-center justify-between gap-2 rounded-lg border border-brand-100 px-2.5 py-1.5">
                <div className="flex min-w-0 items-center gap-2">
                  {Icon && (
                    <span className="shrink-0 text-brand-400">
                      <Icon width={13} height={13} />
                    </span>
                  )}
                  <div className="min-w-0">
                    <p className="truncate text-xs font-medium text-brand-800">{labelKey ? t(labelKey) : key}</p>
                    {enabled && (
                      <Badge variant="outline" className={managed ? 'border-transparent bg-accent-100 px-1.5 py-0 text-[10px] text-accent-700' : 'px-1.5 py-0 text-[10px]'}>
                        {t(SOURCE_LABEL_KEY[source])}
                      </Badge>
                    )}
                    {managed && <p className="text-[10px] text-brand-400">{t('backoffice.clienteDetalle.modules.managedHint')}</p>}
                  </div>
                </div>
                <Switch checked={enabled} disabled={togglingKey === key || managed} onChange={(v) => handleToggle(key, v)} />
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
