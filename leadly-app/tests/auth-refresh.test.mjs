import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveRefresh } from '../src/lib/authRefresh.ts'

const prev = { id: 't1', status: 'inactive' }

test('a failed read keeps the previous state (network error is not "does not exist")', () => {
  assert.equal(resolveRefresh(prev, { ok: false }), prev)
})

test('a successful read replaces the previous state', () => {
  const next = { id: 't1', status: 'active' }
  assert.equal(resolveRefresh(prev, { ok: true, data: next }), next)
})

test('a successful read of a non-existent row yields null (really missing)', () => {
  assert.equal(resolveRefresh(prev, { ok: true, data: null }), null)
})

test('a failed read with no previous state stays null', () => {
  assert.equal(resolveRefresh(null, { ok: false }), null)
})
