import { supabase } from '../supabaseClient'
import type { Opportunity, Pipeline, PipelineStage, OpportunityPriority } from '../../types/domain'

export interface OpportunityInput {
  tenant_id: string
  pipeline_id: string
  stage_id: string
  contact_id: string
  owner_id?: string | null
  title: string
  value?: number
  currency?: string
  priority?: OpportunityPriority
  source?: string | null
  expected_close_date?: string | null
  description?: string | null
}

/** A tenant gets exactly one pipeline today (seeded automatically when the
 * tenant is created, see the seed_default_pipeline trigger) -- this just
 * reads it back, nothing creates one from the frontend yet. */
export async function getDefaultPipeline(tenantId: string): Promise<Pipeline | null> {
  const { data, error } = await supabase.from('pipelines').select('*').eq('tenant_id', tenantId).eq('is_active', true).order('created_at').limit(1).maybeSingle()
  if (error) throw error
  return data
}

export async function listStages(pipelineId: string): Promise<PipelineStage[]> {
  const { data, error } = await supabase.from('pipeline_stages').select('*').eq('pipeline_id', pipelineId).order('display_order')
  if (error) throw error
  return data
}

export type OpportunityWithRelations = Opportunity & {
  contact: { full_name: string; phone_prefix: string | null; phone: string | null; email: string | null } | null
  stage: { name: string; color: string; probability: number; is_won: boolean; is_lost: boolean } | null
  owner: { full_name: string } | null
}

/** `pipelineId` is optional for backwards compatibility, but the Kanban must
 * always pass it once a tenant has more than one pipeline -- otherwise
 * opportunities from every pipeline would mix into the same board/metrics. */
export async function listOpportunities(tenantId: string, pipelineId?: string): Promise<OpportunityWithRelations[]> {
  let query = supabase
    .from('opportunities')
    .select('*, contact:clients(full_name, phone_prefix, phone, email), stage:pipeline_stages(name, color, probability, is_won, is_lost), owner:profiles!owner_id(full_name)')
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .order('updated_at', { ascending: false })
  if (pipelineId) query = query.eq('pipeline_id', pipelineId)
  const { data, error } = await query
  if (error) throw error
  return data as unknown as OpportunityWithRelations[]
}

/** "Opportunities" tab on ClientDetail.tsx. */
export async function listOpportunitiesForContact(contactId: string): Promise<OpportunityWithRelations[]> {
  const { data, error } = await supabase
    .from('opportunities')
    .select('*, contact:clients(full_name, phone_prefix, phone, email), stage:pipeline_stages(name, color, probability, is_won, is_lost), owner:profiles!owner_id(full_name)')
    .eq('contact_id', contactId)
    .is('deleted_at', null)
    .order('updated_at', { ascending: false })
  if (error) throw error
  return data as unknown as OpportunityWithRelations[]
}

export async function createOpportunity(input: OpportunityInput): Promise<Opportunity> {
  const { data, error } = await supabase.from('opportunities').insert(input).select().single()
  if (error) throw error
  return data
}

export interface OpportunityUpdateInput extends Partial<OpportunityInput> {
  status?: 'open' | 'won' | 'lost'
}

export async function updateOpportunity(id: string, input: OpportunityUpdateInput): Promise<Opportunity> {
  const { data, error } = await supabase.from('opportunities').update(input).eq('id', id).select().single()
  if (error) throw error
  return data
}

/** Moving to a stage flagged is_won/is_lost also updates the opportunity's
 * own status -- keeps "status" a cheap filter without joining stages every
 * time, while the stage itself stays the single source of truth for which
 * stages count as won/lost. */
export async function moveOpportunityToStage(id: string, stage: PipelineStage): Promise<Opportunity> {
  const status = stage.is_won ? 'won' : stage.is_lost ? 'lost' : 'open'
  return updateOpportunity(id, { stage_id: stage.id, status })
}

export interface StageHistoryRow {
  opportunity_id: string
  created_at: string
  to_stage: { is_won: boolean; is_lost: boolean } | null
}

/** Feeds the Kanban header's "Conversión"/"Tiempo promedio" metrics -- see
 * opportunity_stage_history (CLAUDE.md 3.7). Without this, those numbers
 * would have to be guessed instead of computed from when opportunities
 * actually entered their closing stage. */
export async function listStageHistoryForOpportunities(opportunityIds: string[]): Promise<StageHistoryRow[]> {
  if (opportunityIds.length === 0) return []
  const { data, error } = await supabase
    .from('opportunity_stage_history')
    .select('opportunity_id, created_at, to_stage:pipeline_stages!to_stage_id(is_won, is_lost)')
    .in('opportunity_id', opportunityIds)
    .order('created_at', { ascending: true })
  if (error) throw error
  return data as unknown as StageHistoryRow[]
}

export interface PipelineMetrics {
  totalValue: number
  wonValue: number
  lostValue: number
  count: number
  conversionPct: number | null
  avgCloseDays: number | null
}

/** Pure computation, not a query -- kept here (not in the Kanban page) so
 * it's testable/reusable independent of any component. `conversionPct`/
 * `avgCloseDays` are null (not 0) when there's no closed opportunity yet --
 * "0% conversión" and "no conversion data yet" are different facts, the UI
 * should say "—" for the latter, not a misleading zero. `totalValue` mixes
 * open/won/lost together (the pipeline's raw size) -- `wonValue`/`lostValue`
 * exist separately so a tenant can actually see how much they've closed one
 * way or the other, since that used to be invisible (only guessable by
 * scrolling the Ganado/Perdido columns and adding cards up by hand). */
export function computePipelineMetrics(opportunities: OpportunityWithRelations[], history: StageHistoryRow[]): PipelineMetrics {
  const totalValue = opportunities.reduce((sum, o) => sum + o.value, 0)
  const wonOpps = opportunities.filter((o) => o.status === 'won')
  const lostOpps = opportunities.filter((o) => o.status === 'lost')
  const wonValue = wonOpps.reduce((sum, o) => sum + o.value, 0)
  const lostValue = lostOpps.reduce((sum, o) => sum + o.value, 0)
  const closed = wonOpps.length + lostOpps.length
  const conversionPct = closed > 0 ? (wonOpps.length / closed) * 100 : null

  const createdAtByOpp = new Map(opportunities.map((o) => [o.id, o.created_at]))
  const closeDurations: number[] = []
  for (const row of history) {
    if (!row.to_stage || (!row.to_stage.is_won && !row.to_stage.is_lost)) continue
    const createdAt = createdAtByOpp.get(row.opportunity_id)
    if (!createdAt) continue
    const days = (new Date(row.created_at).getTime() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24)
    if (days >= 0) closeDurations.push(days)
  }
  const avgCloseDays = closeDurations.length > 0 ? closeDurations.reduce((sum, d) => sum + d, 0) / closeDurations.length : null

  return { totalValue, wonValue, lostValue, count: opportunities.length, conversionPct, avgCloseDays }
}

export async function deleteOpportunity(id: string): Promise<void> {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const { error } = await supabase.from('opportunities').update({ deleted_at: new Date().toISOString(), deleted_by: user?.id ?? null }).eq('id', id)
  if (error) throw error
}
