import { useEffect, useState } from 'react'
import { listEnabledModuleKeys, setModuleEnabled } from '../../lib/api/tenantModules'
import { TENANT_MODULES } from '../../lib/modules'
import { useAuth } from '../../contexts/AuthContext'
import { useLanguage } from '../../contexts/LanguageContext'
import { PageSpinner, Switch } from '@/components/atoms'
/** Toggles apply immediately (same pattern as ai_assistant_skills' SkillsSection)
 * -- independent of any "Guardar cambios" button. A tenant with no modules
 * enabled loses access to that section of the panel entirely (nav item hidden,
 * route locked via RequireModule) -- this is where the superadmin turns them
 * back on. */
export function TenantModulesSection({ tenantId }: { tenantId: string }) {
  const { profile } = useAuth()
  const { t } = useLanguage()
  const [enabledKeys, setEnabledKeys] = useState<Set<string> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [togglingKey, setTogglingKey] = useState<string | null>(null)

  useEffect(() => {
    setEnabledKeys(null)
    setError(null)
    listEnabledModuleKeys(tenantId)
      .then(setEnabledKeys)
      .catch((err) => setError(err.message ?? t('backoffice.clienteDetalle.modules.errors.load')))
  }, [tenantId, t])

  async function handleToggle(moduleKey: string, enable: boolean) {
    setTogglingKey(moduleKey)
    setError(null)
    try {
      await setModuleEnabled(tenantId, moduleKey, enable, profile?.id ?? '')
      setEnabledKeys((prev) => {
        const next = new Set(prev)
        if (enable) next.add(moduleKey)
        else next.delete(moduleKey)
        return next
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : t('backoffice.clienteDetalle.modules.errors.toggle'))
    } finally {
      setTogglingKey(null)
    }
  }

  return (
    <div className="space-y-3">
      <p className="-mt-1 text-xs text-brand-400">{t('backoffice.clienteDetalle.modules.subtitle')}</p>
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {!enabledKeys && !error && <PageSpinner />}
      {enabledKeys && (
        <div className="grid gap-1.5 sm:grid-cols-2">
          {TENANT_MODULES.filter((module) => !module.alwaysEnabled).map((module) => {
            const Icon = module.icon
            const enabled = enabledKeys.has(module.key)
            return (
              <div key={module.key} className="flex items-center justify-between gap-2 rounded-lg border border-brand-100 px-2.5 py-1.5">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="shrink-0 text-brand-400">
                    <Icon width={13} height={13} />
                  </span>
                  <p className="truncate text-sm font-medium text-brand-800">{t(module.labelKey)}</p>
                </div>
                <Switch checked={enabled} disabled={togglingKey === module.key} onChange={(v) => handleToggle(module.key, v)} />
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
