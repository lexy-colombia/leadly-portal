import test from 'node:test'
import assert from 'node:assert/strict'
import { groupTenantModules } from '../src/lib/moduleHierarchy.ts'

const modules = (...keys) => keys.map((key) => ({ key }))

test('materials is nested under products and never duplicated as a root', () => {
  const tree = groupTenantModules(modules('dashboard', 'products', 'materials', 'sales'))
  assert.deepEqual(tree.map((node) => node.key), ['dashboard', 'products', 'sales'])
  assert.deepEqual(tree[1].children.map((node) => node.key), ['materials'])
})

test('a permitted child remains reachable without granting its disabled parent', () => {
  const tree = groupTenantModules(modules('materials'))
  assert.equal(tree[0].key, 'products')
  assert.equal(tree[0].module, undefined)
  assert.equal(tree[0].children[0].module.key, 'materials')
})

test('CRM is preserved when dashboard is disabled and products has children', () => {
  const tree = groupTenantModules(modules('conversations', 'products', 'materials', 'calendar'))
  assert.deepEqual(tree.map((node) => node.key), ['crm', 'products'])
  assert.deepEqual(tree[0].children.map((node) => node.key), ['conversations', 'calendar'])
})

test('CRM follows dashboard; hidden capabilities stay under their owning sections', () => {
  const input = modules('dashboard', 'conversations', 'sales', 'dispatches', 'einvoicing', 'inventory', 'storefront', 'settings', 'integrations')
  const tree = groupTenantModules(input)
  assert.deepEqual(tree.map((node) => node.key), ['dashboard', 'crm', 'sales', 'settings', 'integrations'])
  assert.deepEqual(tree[2].children.map((node) => node.key), ['dispatches'])
  assert.deepEqual(tree[4].children.map((node) => node.key), ['einvoicing'])
  assert.deepEqual(tree[3].children.map((node) => node.key), ['inventory', 'storefront'])
  const flatten = (nodes) => nodes.flatMap((node) => [...(node.module ? [node.module.key] : []), ...flatten(node.children)])
  assert.deepEqual(flatten(tree).sort(), input.map((module) => module.key).sort())
})

test('no modules means no empty groups', () => {
  assert.deepEqual(groupTenantModules([]), [])
})

test('parent selection enables the group and child edits make it indeterminate', async () => {
  const { moduleSelectionState, updateModuleSelection } = await import('../src/lib/moduleHierarchy.ts')
  const original = new Set(['dashboard', 'products'])
  const selected = updateModuleSelection(original, ['products', 'materials'], true)
  assert.equal(moduleSelectionState(['products', 'materials'], selected), true)
  assert.equal(original.has('materials'), false)
  const customized = updateModuleSelection(selected, ['materials'], false)
  assert.equal(moduleSelectionState(['products', 'materials'], customized), 'indeterminate')
  assert.equal(customized.has('products'), true)
  assert.equal(customized.has('dashboard'), true)
  const cleared = updateModuleSelection(customized, ['products', 'materials'], false)
  assert.equal(moduleSelectionState(['products', 'materials'], cleared), false)
  assert.equal(cleared.has('dashboard'), true)
})

test('virtual CRM parent selects only real child keys', async () => {
  const { moduleSelectionState, updateModuleSelection } = await import('../src/lib/moduleHierarchy.ts')
  const tree = groupTenantModules(modules('conversations', 'calendar', 'channels'))
  const keys = tree[0].children.map((child) => child.key)
  const selected = updateModuleSelection(new Set(), keys, true)
  assert.equal(moduleSelectionState(keys, selected), true)
  assert.equal(selected.has('crm'), false)
  assert.deepEqual([...selected].sort(), ['calendar', 'channels', 'conversations'])
})
