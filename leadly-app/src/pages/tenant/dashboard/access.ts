/** Mirror the existing module/action gates. Unknown/loading access always fails closed. */
export function dashboardAccess(
  tenantId: string,
  role: string | undefined,
  modules: ReadonlySet<string> | null,
  permissions: ReadonlySet<string> | null,
) {
  const can = (module: string, action?: string) =>
    !!tenantId &&
    !!modules?.has(module) &&
    (!action || !!permissions?.has(action))
  const sales = can('sales', 'sales.view'),
    products = can('products', 'products.view'),
    tasks = can('calendar', 'calendar.view')
  return {
    attention:
      can('conversations', 'conversations.view') ||
      can('pipeline', 'pipeline.view') ||
      tasks,
    sales,
    products,
    tasks,
    dispatches: can('dispatches') && sales,
    credit: can('credit', 'credit.view'),
    reports: can('reports', 'reports.view'),
    pipeline: can('pipeline', 'pipeline.view'),
    stock: products && can('inventory'),
    conversations: can('conversations', 'conversations.view'),
    returns: can('returns', 'returns.view'),
    team: tasks && role === 'tenant_admin',
    newSale: can('pos', 'pos.view') && !!permissions?.has('sales.create'),
  }
}
