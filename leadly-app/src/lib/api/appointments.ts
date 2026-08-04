import { supabase } from '../supabaseClient'
import type { AppointmentStatus, CrmAppointment } from '../../types/domain'

export async function listAppointmentsForContact(contactId: string): Promise<CrmAppointment[]> {
  const { data, error } = await supabase
    .from('crm_appointments')
    .select('*')
    .eq('contact_id', contactId)
    .order('scheduled_at', { ascending: true })
  if (error) throw error
  return data
}

/** Resolves the line to send the WhatsApp reminder through from the
 * contact's most recent conversation -- the agent scheduling the appointment
 * doesn't pick a line manually, it's implicit from where the conversation is
 * already happening. */
export async function createAppointment(
  tenantId: string,
  contactId: string,
  scheduledAt: string,
  notes: string,
): Promise<CrmAppointment> {
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const { data: conv } = await supabase
    .from('whatsapp_conversations')
    .select('whatsapp_line_id')
    .eq('contact_id', contactId)
    .order('last_message_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const { data, error } = await supabase
    .from('crm_appointments')
    .insert({
      tenant_id: tenantId,
      contact_id: contactId,
      whatsapp_line_id: conv?.whatsapp_line_id ?? null,
      scheduled_at: scheduledAt,
      notes: notes || null,
      created_by: user?.id ?? null,
    })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function updateAppointmentStatus(id: string, status: AppointmentStatus): Promise<CrmAppointment> {
  const { data, error } = await supabase.from('crm_appointments').update({ status }).eq('id', id).select().single()
  if (error) throw error
  return data
}
