/** Shared presentation hierarchy. Grouping never grants module access. */
export const CRM_MODULE_KEYS = ['conversations', 'channels', 'pipeline', 'tasks', 'calendar', 'campaigns', 'aiAgents']

const MODULE_PARENT: Record<string, string> = {
  materials: 'products',
  inventory: 'settings',
  dispatches: 'sales',
  einvoicing: 'integrations',
  storefront: 'settings',
}

export interface ModuleNode<T> {
  key: string
  module?: T
  children: ModuleNode<T>[]
}

export function groupTenantModules<T extends { key: string }>(modules: T[]): ModuleNode<T>[] {
  const nodes = new Map<string, ModuleNode<T>>(modules.map((module) => [module.key, { key: module.key, module, children: [] }]))
  const roots: ModuleNode<T>[] = []
  for (const module of modules) {
    const parentKey = CRM_MODULE_KEYS.includes(module.key) ? 'crm' : MODULE_PARENT[module.key]
    if (parentKey && !nodes.has(parentKey)) nodes.set(parentKey, { key: parentKey, children: [] })
    const node = nodes.get(module.key)!
    if (parentKey) nodes.get(parentKey)!.children.push(node)
    else roots.push(node)
  }
  // A parent can remain a presentation group when only its child is enabled.
  for (const node of nodes.values()) {
    if (!node.module && node.key !== 'crm' && node.children.length) roots.push(node)
  }
  const crm = nodes.get('crm')
  if (crm?.children.length) {
    const dashboardIndex = roots.findIndex((node) => node.key === 'dashboard')
    roots.splice(dashboardIndex + 1, 0, crm)
  }
  return roots
}

/** Aggregate parents reflect partial selections without changing their children. */
export function moduleSelectionState(keys: readonly string[], selected: ReadonlySet<string>): boolean | 'indeterminate' {
  const count = keys.filter((key) => selected.has(key)).length
  return count === 0 ? false : count === keys.length ? true : 'indeterminate'
}

export function updateModuleSelection(selected: ReadonlySet<string>, keys: readonly string[], checked: boolean): Set<string> {
  const next = new Set(selected)
  for (const key of keys) {
    if (checked) next.add(key)
    else next.delete(key)
  }
  return next
}
