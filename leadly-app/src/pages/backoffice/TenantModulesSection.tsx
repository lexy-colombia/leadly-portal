import { useEffect, useState } from 'react'
import { listEnabledModuleSources, setModuleEnabled, type TenantModuleSource } from '../../lib/api/tenantModules'
import { TENANT_MODULES } from '../../lib/modules'
import { PLAN_MODULE_KEYS, moduleLabelKey } from '../../lib/planModules'
import { useAuth } from '../../contexts/AuthContext'
import { useLanguage } from '../../contexts/LanguageContext'
import { PageSpinner } from '@/components/atoms'
import { ModuleSelector } from '@/components/organisms/ModuleSelector'
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
    let active = true
    setSources(null)
    setError(null)
    listEnabledModuleSources(tenantId)
      .then((next) => { if (active) setSources(next) })
      .catch((err) => { if (active) setError(err.message ?? t('backoffice.clienteDetalle.modules.errors.load')) })
    return () => { active = false }
  }, [tenantId, t])

  async function handleToggle(keys: string[], enable: boolean) {
    setTogglingKey(keys[0] ?? '')
    setError(null)
    try {
      const results = await Promise.allSettled(keys.map((key) => setModuleEnabled(tenantId, key, enable, profile?.id ?? '')))
      setSources((prev) => {
        const next = new Map(prev)
        results.forEach((result, index) => {
          if (result.status !== 'fulfilled') return
          if (enable) next.set(keys[index], 'manual')
          else next.delete(keys[index])
        })
        return next
      })
      const failure = results.find((result) => result.status === 'rejected')
      if (failure?.status === 'rejected') setError(failure.reason instanceof Error ? failure.reason.message : t('backoffice.clienteDetalle.modules.errors.toggle'))
    } finally {
      setTogglingKey(null)
    }
  }

  const rows = [
    ...TENANT_MODULES.filter((module) => !module.alwaysEnabled).map((module) => ({ key: module.key, icon: module.icon })),
    ...PLAN_MODULE_KEYS.filter((key) => !TENANT_MODULES.some((module) => module.key === key)).map((key) => ({ key, icon: null })),
  ]

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs leading-relaxed text-muted-foreground">{t('backoffice.clienteDetalle.modules.subtitle')}</p>
      {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
      {!sources && !error && <PageSpinner />}
      {sources && <ModuleSelector
        moduleKeys={rows.map((row) => row.key)}
        selected={new Set(sources.keys())}
        onChange={handleToggle}
        labelFor={(key) => { const labelKey = moduleLabelKey(key); return labelKey ? t(labelKey) : key }}
        disabled={togglingKey !== null}
        locked={(key) => sources.get(key) === 'plan' || sources.get(key) === 'subscription'}
        sourceLabel={(key) => { const source = sources.get(key); return source && source !== 'manual' ? t(SOURCE_LABEL_KEY[source]) : undefined }}
      />}
    </div>
  )
}
