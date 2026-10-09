import type { MessageTiming } from '../../../lib/api/conversations'

export function computeAvgResponseMinutes(
  timings: MessageTiming[],
  windowStart: Date,
  windowEnd: Date,
): number | null {
  const byConversation = new Map<string, MessageTiming[]>()
  for (const t of timings) {
    const list = byConversation.get(t.conversation_id)
    if (list) list.push(t)
    else byConversation.set(t.conversation_id, [t])
  }

  const gaps: number[] = []
  for (const msgs of byConversation.values()) {
    for (let i = 1; i < msgs.length; i++) {
      const prev = msgs[i - 1]
      const curr = msgs[i]
      if (prev.direction !== 'inbound' || curr.direction !== 'outbound')
        continue
      const respondedAt = new Date(curr.created_at)
      if (respondedAt < windowStart || respondedAt >= windowEnd) continue
      const gapMinutes =
        (respondedAt.getTime() - new Date(prev.created_at).getTime()) / 60_000
      if (gapMinutes >= 0 && gapMinutes <= 60 * 24) gaps.push(gapMinutes)
    }
  }
  if (gaps.length === 0) return null
  return gaps.reduce((sum, g) => sum + g, 0) / gaps.length
}

export function periodWindow(days: number, now = new Date()) {
  const end = new Date(now)
  end.setHours(0, 0, 0, 0)
  end.setDate(end.getDate() + 1)
  const start = new Date(end)
  start.setDate(start.getDate() - days)
  const previousStart = new Date(start)
  previousStart.setDate(previousStart.getDate() - days)
  return { start, end, previousStart }
}
export function dailySales(
  orders: { created_at: string; total: number; status: string }[],
  start: Date,
  end: Date,
) {
  const key = (date: Date) =>
    `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
  const map = new Map<string, { date: Date; value: number }>()
  for (const day = new Date(start); day < end; day.setDate(day.getDate() + 1))
    map.set(key(day), { date: new Date(day), value: 0 })
  for (const order of orders) {
    const date = new Date(order.created_at)
    if (order.status !== 'confirmada' || date < start || date >= end) continue
    const bucket = map.get(key(date))
    if (bucket) bucket.value += order.total
  }
  return [...map.values()]
}
export function pendingOrders<
  T extends { status: string; delivery_status: string },
>(orders: T[]) {
  return orders.filter(
    (order) =>
      order.status === 'confirmada' && order.delivery_status !== 'entregado',
  )
}
