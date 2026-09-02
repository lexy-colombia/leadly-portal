import { supabase } from '../supabaseClient'

/** Resumen de tareas + citas por agente -- Fase 4 de "oportunidades/tareas/
 * citas transversal" (2026-09-02): antes no existía ninguna forma de medir
 * si un agente cumple lo que tiene asignado. Envuelve get_agent_activity_
 * summary (RPC de solo lectura, security invoker -- la RLS de tasks/
 * appointments/profiles es el límite real, ver la migración). */
export interface AgentActivitySummary {
  agent_id: string
  agent_name: string
  tasks_pending: number
  tasks_overdue: number
  tasks_completed_on_time: number
  tasks_completed_late: number
  appointments_pending: number
  appointments_overdue: number
  appointments_completed: number
}

export async function getAgentActivitySummary(tenantId: string): Promise<AgentActivitySummary[]> {
  const { data, error } = await supabase.rpc('get_agent_activity_summary', { p_tenant_id: tenantId })
  if (error) throw error
  return (data ?? []) as AgentActivitySummary[]
}
