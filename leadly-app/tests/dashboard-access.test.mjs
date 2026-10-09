import test from 'node:test'
import assert from 'node:assert/strict'
import { dashboardAccess } from '../src/pages/tenant/dashboard/access.ts'

test('loading permissions and modules fail closed, including for admins', () => {
  assert(
    Object.values(dashboardAccess('tenant', 'tenant_admin', null, null)).every(
      (value) => value === false,
    ),
  )
})
test('having a module does not substitute for its required action permission', () => {
  const access = dashboardAccess(
    'tenant',
    'tenant_agent',
    new Set(['sales', 'credit', 'reports', 'pipeline', 'conversations']),
    new Set(),
  )
  assert.equal(access.sales, false)
  assert.equal(access.credit, false)
  assert.equal(access.reports, false)
  assert.equal(access.pipeline, false)
  assert.equal(access.conversations, false)
})
test('operational-only plan does not enable CRM, team performance or WhatsApp', () => {
  const access = dashboardAccess(
    'tenant',
    'tenant_admin',
    new Set(['sales', 'products', 'inventory', 'dispatches', 'credit']),
    new Set(['sales.view', 'products.view', 'credit.view']),
  )
  assert.equal(access.sales, true)
  assert.equal(access.dispatches, true)
  assert.equal(access.stock, true)
  assert.equal(access.credit, true)
  assert.equal(access.pipeline, false)
  assert.equal(access.team, false)
  assert.equal(access.conversations, false)
})
test('team metrics require admin role and calendar permission; new sales require POS and creation permission', () => {
  const modules = new Set(['calendar', 'pos'])
  const permissions = new Set(['calendar.view', 'pos.view', 'sales.create'])
  assert.equal(
    dashboardAccess('tenant', 'tenant_admin', modules, permissions).team,
    true,
  )
  assert.equal(
    dashboardAccess('tenant', 'tenant_agent', modules, permissions).team,
    false,
  )
  assert.equal(
    dashboardAccess('tenant', 'tenant_agent', modules, permissions).newSale,
    true,
  )
  assert.equal(
    dashboardAccess('tenant', 'tenant_agent', modules, new Set(['pos.view']))
      .newSale,
    false,
  )
  assert(
    Object.values(
      dashboardAccess('', 'tenant_admin', modules, permissions),
    ).every((value) => value === false),
  )
})

test('CRM view is available without WhatsApp when pipeline or calendar is enabled',()=>{
 const pipeline=dashboardAccess('tenant','tenant_agent',new Set(['pipeline']),new Set(['pipeline.view']));
 assert.equal(pipeline.attention,true);assert.equal(pipeline.conversations,false);
 const calendar=dashboardAccess('tenant','tenant_agent',new Set(['calendar']),new Set(['calendar.view']));
 assert.equal(calendar.attention,true);assert.equal(calendar.conversations,false);
});
