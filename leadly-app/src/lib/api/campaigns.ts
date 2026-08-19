import { supabase } from '../supabaseClient'
import type { Campaign, CampaignRecipient } from '../../types/domain'

export type CampaignWithRelations = Campaign & {
  template: { name: string } | null
  whatsapp_line: { display_name: string } | null
}

export async function listCampaigns(tenantId: string): Promise<CampaignWithRelations[]> {
  const { data, error } = await supabase
    .from('campaigns')
    .select('*, template:whatsapp_message_templates(name), whatsapp_line:whatsapp_lines(display_name)')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
  if (error) throw error
  return data as unknown as CampaignWithRelations[]
}

export async function getCampaign(id: string): Promise<CampaignWithRelations | null> {
  const { data, error } = await supabase
    .from('campaigns')
    .select('*, template:whatsapp_message_templates(name), whatsapp_line:whatsapp_lines(display_name)')
    .eq('id', id)
    .maybeSingle()
  if (error) throw error
  return data as unknown as CampaignWithRelations | null
}

export async function listCampaignRecipients(campaignId: string): Promise<CampaignRecipient[]> {
  const { data, error } = await supabase
    .from('campaign_recipients')
    .select('*')
    .eq('campaign_id', campaignId)
    .order('created_at', { ascending: true })
  if (error) throw error
  return data
}

export interface ParsedRecipient {
  contact_phone: string
  contact_name: string
  variables: string[]
}

export interface CreateCampaignInput {
  tenant_id: string
  name: string
  whatsapp_line_id: string
  template_id: string
  topic: string
  /** Ya en ISO -- el picker de fecha/hora del wizard resuelve el timezone
   * local del navegador antes de llamar acá. */
  scheduled_at: string
  recipients: ParsedRecipient[]
}

/** Inserta la campaña + todos sus destinatarios. Si el insert de
 * destinatarios falla, borra la campaña recién creada (hard delete, mismo
 * criterio que createWhatsappLine::rollback -- todavía no pasó nada real,
 * no hay historial que perder). run-campaigns (cron) es quien la pasa a
 * status sending/completed, acá siempre nace en 'scheduled'. */
export async function createCampaign(input: CreateCampaignInput): Promise<Campaign> {
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const { data: campaign, error: campaignError } = await supabase
    .from('campaigns')
    .insert({
      tenant_id: input.tenant_id,
      name: input.name,
      whatsapp_line_id: input.whatsapp_line_id,
      template_id: input.template_id,
      topic: input.topic.trim() || null,
      scheduled_at: input.scheduled_at,
      status: 'scheduled',
      total_recipients: input.recipients.length,
      created_by: user?.id ?? null,
    })
    .select()
    .single()
  if (campaignError) throw campaignError

  const { error: recipientsError } = await supabase.from('campaign_recipients').insert(
    input.recipients.map((r) => ({
      tenant_id: input.tenant_id,
      campaign_id: campaign.id,
      contact_phone: r.contact_phone,
      contact_name: r.contact_name || null,
      variables: r.variables,
    })),
  )
  if (recipientsError) {
    await supabase.from('campaigns').delete().eq('id', campaign.id)
    throw recipientsError
  }

  return campaign
}

export interface UpdateCampaignInput {
  name: string
  whatsapp_line_id: string
  template_id: string
  topic: string
  scheduled_at: string
  recipients: ParsedRecipient[]
}

/** Solo tiene efecto sobre una campaña todavía 'scheduled' -- misma
 * condición que cancelCampaign, ver el .eq('status', 'scheduled') de abajo.
 * Una vez que run-campaigns la toma no hay nada que editar: pudo haber
 * mensajes ya enviados. Reemplaza los destinatarios enteros (delete + insert,
 * ver migración 20260819000001) en vez de diffear -- seguro porque en
 * 'scheduled' ninguno pudo haberse enviado todavía. */
export async function updateCampaign(id: string, tenantId: string, input: UpdateCampaignInput): Promise<void> {
  const { error: campaignError } = await supabase
    .from('campaigns')
    .update({
      name: input.name,
      whatsapp_line_id: input.whatsapp_line_id,
      template_id: input.template_id,
      topic: input.topic.trim() || null,
      scheduled_at: input.scheduled_at,
      total_recipients: input.recipients.length,
    })
    .eq('id', id)
    .eq('status', 'scheduled')
  if (campaignError) throw campaignError

  const { error: deleteError } = await supabase.from('campaign_recipients').delete().eq('campaign_id', id)
  if (deleteError) throw deleteError

  const { error: insertError } = await supabase.from('campaign_recipients').insert(
    input.recipients.map((r) => ({
      tenant_id: tenantId,
      campaign_id: id,
      contact_phone: r.contact_phone,
      contact_name: r.contact_name || null,
      variables: r.variables,
    })),
  )
  if (insertError) throw insertError
}

export async function cancelCampaign(id: string): Promise<void> {
  const { error } = await supabase.from('campaigns').update({ status: 'canceled' }).eq('id', id).eq('status', 'scheduled')
  if (error) throw error
}
