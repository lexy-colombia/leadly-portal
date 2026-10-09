import test from 'node:test'
import assert from 'node:assert/strict'
import {
  periodWindow,
  dailySales,
  pendingOrders,
  computeAvgResponseMinutes,
} from '../src/pages/tenant/dashboard/metrics.ts'

test('period uses local calendar days and an exclusive end, with an equally sized previous range', () => {
  const range = periodWindow(7, new Date(2026, 9, 8, 16, 30))
  assert.equal(range.start.getDate(), 2)
  assert.equal(range.start.getHours(), 0)
  assert.equal(range.end.getDate(), 9)
  assert.equal(range.previousStart.getDate(), 25)
  assert.equal(range.previousStart.getMonth(), 8)
})
test('sales excludes quotes, cancellations, earlier history and the exclusive end', () => {
  const { start, end } = periodWindow(7, new Date(2026, 9, 8))
  const orders = [
    { created_at: start.toISOString(), total: 125, status: 'confirmada' },
    {
      created_at: new Date(2026, 9, 8, 23, 59).toISOString(),
      total: 75,
      status: 'confirmada',
    },
    { created_at: end.toISOString(), total: 500, status: 'confirmada' },
    { created_at: start.toISOString(), total: 500, status: 'cotizacion' },
    { created_at: start.toISOString(), total: 500, status: 'cancelada' },
    {
      created_at: new Date(2026, 8, 1).toISOString(),
      total: 500,
      status: 'confirmada',
    },
  ]
  const points = dailySales(orders, start, end)
  assert.equal(points.length, 7)
  assert.equal(
    points.reduce((s, p) => s + p.value, 0),
    200,
  )
  assert.equal(points[0].value, 125)
  assert.equal(points.at(-1).value, 75)
})
test('pending orders includes old confirmed orders and excludes delivered and unconfirmed orders', () => {
  const orders = [
    {
      id: 'old',
      created_at: '2020-01-01',
      status: 'confirmada',
      delivery_status: 'pendiente',
    },
    { id: 'done', status: 'confirmada', delivery_status: 'entregado' },
    { id: 'quote', status: 'cotizacion', delivery_status: 'pendiente' },
    { id: 'cancel', status: 'cancelada', delivery_status: 'pendiente' },
  ]
  assert.deepEqual(
    pendingOrders(orders).map((o) => o.id),
    ['old'],
  )
})
test('response metric uses real inbound/outbound pairs and excludes pauses over 24 hours', () => {
  const start = new Date('2026-10-01T00:00:00Z'),
    end = new Date('2026-10-09T00:00:00Z')
  const rows = [
    {
      conversation_id: 'a',
      direction: 'inbound',
      created_at: '2026-10-08T10:00:00Z',
    },
    {
      conversation_id: 'a',
      direction: 'outbound',
      created_at: '2026-10-08T10:04:00Z',
    },
    {
      conversation_id: 'b',
      direction: 'inbound',
      created_at: '2026-10-01T10:00:00Z',
    },
    {
      conversation_id: 'b',
      direction: 'outbound',
      created_at: '2026-10-08T10:00:00Z',
    },
  ]
  assert.equal(computeAvgResponseMinutes(rows, start, end), 4)
  assert.equal(computeAvgResponseMinutes([], start, end), null)
})
