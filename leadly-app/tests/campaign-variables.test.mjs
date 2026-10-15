import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveVariable, encodeSource, decodeSource, FREE_SOURCE } from '../src/lib/campaignVariables.ts'

const client = {
  full_name: ' María Fernanda Pérez ',
  phone_prefix: '57',
  phone: '3105797260',
  email: null,
  company: null,
  document_number: '123',
  custom_fields: { 'def-proy': 'El Nogal', 'def-unidad': 'Torre 3 Apto 101', 'def-bool': true, 'def-num': 450000 },
}

test('campos estándar', () => {
  assert.equal(resolveVariable({ kind: 'field', field: 'full_name' }, client), 'María Fernanda Pérez')
  assert.equal(resolveVariable({ kind: 'field', field: 'first_name' }, client), 'María')
  assert.equal(resolveVariable({ kind: 'field', field: 'phone' }, client), '573105797260')
  assert.equal(resolveVariable({ kind: 'field', field: 'email' }, client), '')
})

test('campos personalizados por id de definición', () => {
  assert.equal(resolveVariable({ kind: 'custom', definitionId: 'def-proy' }, client), 'El Nogal')
  assert.equal(resolveVariable({ kind: 'custom', definitionId: 'def-bool' }, client), 'Sí')
  assert.equal(resolveVariable({ kind: 'custom', definitionId: 'def-num' }, client), '450000')
  assert.equal(resolveVariable({ kind: 'custom', definitionId: 'no-existe' }, client), '')
  assert.equal(resolveVariable({ kind: 'custom', definitionId: 'x' }, { ...client, custom_fields: null }), '')
})

test('libre no resuelve nada y la codificación es reversible', () => {
  assert.equal(resolveVariable(FREE_SOURCE, client), '')
  for (const s of [FREE_SOURCE, { kind: 'field', field: 'email' }, { kind: 'custom', definitionId: 'abc' }]) {
    assert.deepEqual(decodeSource(encodeSource(s)), s)
  }
  assert.deepEqual(decodeSource('field:__proto__'), FREE_SOURCE)
})
