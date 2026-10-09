import test from 'node:test'
import assert from 'node:assert/strict'
import { collectById } from '../src/lib/analytics/pagination.ts'

test('datasets over 1000 rows are fully collected using advancing id cursors', async () => {
  const rows = Array.from({ length: 1001 }, (_, i) => ({
    id: String(i).padStart(6, '0'),
    amount: 1,
  }))
  const cursors = []
  const result = await collectById(async (after) => {
    cursors.push(after)
    return rows.filter((row) => after === null || row.id > after).slice(0, 500)
  })
  assert.equal(result.length, 1001)
  assert.equal(
    result.reduce((s, r) => s + r.amount, 0),
    1001,
  )
  assert.equal(new Set(result.map((r) => r.id)).size, 1001)
  assert.deepEqual(cursors, [null, '000499', '000999'])
})
test('an exactly full page is followed by another request instead of assuming completion', async () => {
  const rows = [{ id: 'a' }, { id: 'b' }]
  let calls = 0
  const result = await collectById(async (after) => {
    calls++
    return after ? [] : rows
  }, 2)
  assert.equal(result.length, 2)
  assert.equal(calls, 2)
})
test('query failure is propagated rather than returning partial financial totals', async () => {
  await assert.rejects(
    () =>
      collectById(async () => {
        throw new Error('Access denied')
      }),
    /Access denied/,
  )
})
test('a non-advancing cursor stops rather than looping indefinitely', async () => {
  await assert.rejects(
    () => collectById(async () => [{ id: 'a' }], 1),
    /did not advance/,
  )
})
