import type { TranslationKey } from '../i18n/translations'
import { TENANT_MODULES } from './modules'

/** Grouping used by the plan checklist (PlanDrawer), the Enterprise
 * negotiation table and the apply-plan diff. The keys are the same ones the
 * DB's tenant_enabled_modules / billing_plan_modules CHECK accepts (contract:
 * progress/feature_plans_entitlements.md). `billing` is in Operación even
 * though the contract's checklist omits it: the Starter module list includes
 * it, and without a checkbox a plan could never grant it. */
export const PLAN_MODULE_GROUPS: { key: string; labelKey: TranslationKey; modules: string[] }[] = [
  {
    key: 'operation',
    labelKey: 'backoffice.planModules.group.operation',
    modules: ['dashboard', 'products', 'materials', 'inventory', 'sales', 'pos', 'contacts', 'credit', 'expenses', 'returns', 'reports', 'settings', 'billing'],
  },
  {
    key: 'formalization',
    labelKey: 'backoffice.planModules.group.formalization',
    modules: ['dispatches', 'einvoicing', 'storefront', 'integrations'],
  },
  {
    key: 'conversation',
    labelKey: 'backoffice.planModules.group.conversation',
    modules: ['conversations', 'channels', 'aiAgents', 'pipeline', 'tasks', 'calendar'],
  },
  {
    key: 'advanced',
    labelKey: 'backoffice.planModules.group.advanced',
    modules: ['campaigns', 'automations'],
  },
]

export const PLAN_MODULE_KEYS: string[] = PLAN_MODULE_GROUPS.flatMap((group) => group.modules)

/** 'automations' has a DB key but no tenant-panel screen yet, so it's not in
 * TENANT_MODULES -- label it here instead of adding a fake nav entry. */
const EXTRA_LABEL_KEY: Record<string, TranslationKey> = {
  automations: 'backoffice.modules.automations',
}

export function moduleLabelKey(moduleKey: string): TranslationKey | null {
  return TENANT_MODULES.find((m) => m.key === moduleKey)?.labelKey ?? EXTRA_LABEL_KEY[moduleKey] ?? null
}
