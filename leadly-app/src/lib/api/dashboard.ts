import { supabase } from '../supabaseClient'

function countOrThrow(result: { count: number | null; error: { message: string } | null }): number {
  if (result.error) throw result.error
  return result.count ?? 0
}

export interface BackofficeDashboardStats {
  totalTenants: number
  activeTenants: number
  totalLines: number
  activeLines: number
  /** Conversations with activity (an inbound or outbound message) since
   * local midnight -- "how much is happening across the platform today". */
  conversationsToday: number
}

export async function getBackofficeDashboardStats(): Promise<BackofficeDashboardStats> {
  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)

  const [totalTenantsRes, activeTenantsRes, totalLinesRes, activeLinesRes, conversationsTodayRes] = await Promise.all([
    supabase.from('tenants').select('id', { count: 'exact', head: true }),
    supabase.from('tenants').select('id', { count: 'exact', head: true }).eq('status', 'active'),
    supabase.from('whatsapp_lines').select('id', { count: 'exact', head: true }),
    supabase.from('whatsapp_lines').select('id', { count: 'exact', head: true }).eq('status', 'active'),
    supabase
      .from('whatsapp_conversations')
      .select('id', { count: 'exact', head: true })
      .gte('last_message_at', startOfToday.toISOString()),
  ])

  return {
    totalTenants: countOrThrow(totalTenantsRes),
    activeTenants: countOrThrow(activeTenantsRes),
    totalLines: countOrThrow(totalLinesRes),
    activeLines: countOrThrow(activeLinesRes),
    conversationsToday: countOrThrow(conversationsTodayRes),
  }
}
