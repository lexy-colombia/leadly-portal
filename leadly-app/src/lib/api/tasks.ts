import { supabase } from '../supabaseClient'
import type { CrmTask, TaskPriority, TaskStatus } from '../../types/domain'
import type { TranslationKey } from '../../i18n/translations'

// Shared between the Dashboard widget, Tareas, and TaskDrawer so the priority
// wording never drifts between screens.
export const TASK_PRIORITY_KEY: Record<TaskPriority, TranslationKey> = {
  baja: 'tasks.priority.low',
  media: 'tasks.priority.medium',
  alta: 'tasks.priority.high',
}

export interface TaskInput {
  tenant_id: string
  contact_id?: string | null
  opportunity_id?: string | null
  assigned_to?: string | null
  title: string
  description?: string | null
  priority?: TaskPriority
  status?: TaskStatus
  due_date?: string | null
}

export type TaskWithRelations = CrmTask & {
  contact: { full_name: string } | null
  opportunity: { title: string } | null
  assignee: { full_name: string } | null
}

export async function listTasks(tenantId: string): Promise<TaskWithRelations[]> {
  const { data, error } = await supabase
    .from('crm_tasks')
    .select('*, contact:crm_contacts(full_name), opportunity:crm_opportunities(title), assignee:profiles!assigned_to(full_name)')
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .order('due_date', { ascending: true, nullsFirst: false })
  if (error) throw error
  return data as unknown as TaskWithRelations[]
}

/** Tasks tied to an account -- either directly about one of its contacts, or
 * about one of its opportunities. "Tareas" tab on the Empresa detail screen.
 * An account with no contacts/opportunities yet short-circuits instead of
 * building an `.or()` filter with empty `in()` lists. */
export async function listTasksForAccount(contactIds: string[], opportunityIds: string[]): Promise<TaskWithRelations[]> {
  if (contactIds.length === 0 && opportunityIds.length === 0) return []
  const conditions: string[] = []
  if (contactIds.length > 0) conditions.push(`contact_id.in.(${contactIds.join(',')})`)
  if (opportunityIds.length > 0) conditions.push(`opportunity_id.in.(${opportunityIds.join(',')})`)

  const { data, error } = await supabase
    .from('crm_tasks')
    .select('*, contact:crm_contacts(full_name), opportunity:crm_opportunities(title), assignee:profiles!assigned_to(full_name)')
    .or(conditions.join(','))
    .is('deleted_at', null)
    .order('due_date', { ascending: true, nullsFirst: false })
  if (error) throw error
  return data as unknown as TaskWithRelations[]
}

/** Tasks tab on the opportunity's side panel (OpportunityPanel.tsx). */
export async function listTasksForOpportunity(opportunityId: string): Promise<TaskWithRelations[]> {
  const { data, error } = await supabase
    .from('crm_tasks')
    .select('*, contact:crm_contacts(full_name), opportunity:crm_opportunities(title), assignee:profiles!assigned_to(full_name)')
    .eq('opportunity_id', opportunityId)
    .is('deleted_at', null)
    .order('due_date', { ascending: true, nullsFirst: false })
  if (error) throw error
  return data as unknown as TaskWithRelations[]
}

export async function createTask(input: TaskInput): Promise<CrmTask> {
  const { data, error } = await supabase.from('crm_tasks').insert(input).select().single()
  if (error) throw error
  return data
}

export async function updateTask(id: string, input: Partial<TaskInput>): Promise<CrmTask> {
  const { data, error } = await supabase.from('crm_tasks').update(input).eq('id', id).select().single()
  if (error) throw error
  return data
}

export async function deleteTask(id: string): Promise<void> {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const { error } = await supabase.from('crm_tasks').update({ deleted_at: new Date().toISOString(), deleted_by: user?.id ?? null }).eq('id', id)
  if (error) throw error
}
