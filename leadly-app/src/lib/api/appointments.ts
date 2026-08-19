import { supabase } from '../supabaseClient'
import type { AppointmentStatus, AppointmentWithContact, Appointment } from '../../types/domain'

/** Tenant-wide appointments in a date range (calendar month view) -- unlike
 * listAppointmentsForContact, this isn't scoped to one contact, so it joins
 * clients for the display name. `rangeEnd` is exclusive. */
export async function listAppointmentsForTenantRange(tenantId: string, rangeStart: string, rangeEnd: string): Promise<AppointmentWithContact[]> {
  const { data, error } = await supabase
    .from('appointments')
    .select('*, clients(full_name)')
    .eq('tenant_id', tenantId)
    .gte('scheduled_at', rangeStart)
    .lt('scheduled_at', rangeEnd)
    .order('scheduled_at', { ascending: true })
  if (error) throw error
  return data.map(({ clients, ...appointment }) => ({
    ...appointment,
    contact_full_name: (clients as { full_name: string } | null)?.full_name ?? null,
  }))
}

export async function listAppointmentsForContact(contactId: string): Promise<Appointment[]> {
  const { data, error } = await supabase
    .from('appointments')
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
): Promise<Appointment> {
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
    .from('appointments')
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

/** Reschedules an appointment (date/contact/notes) -- re-resolves
 * whatsapp_line_id the same way createAppointment does, in case the contact
 * changed, and clears reminder_sent_at so the reminder cron re-evaluates it
 * for the new time instead of thinking it already reminded the old one. */
export async function updateAppointment(
  id: string,
  input: { contactId: string; scheduledAt: string; notes: string },
): Promise<Appointment> {
  const { data: conv } = await supabase
    .from('whatsapp_conversations')
    .select('whatsapp_line_id')
    .eq('contact_id', input.contactId)
    .order('last_message_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const { data, error } = await supabase
    .from('appointments')
    .update({
      contact_id: input.contactId,
      whatsapp_line_id: conv?.whatsapp_line_id ?? null,
      scheduled_at: input.scheduledAt,
      notes: input.notes || null,
      reminder_sent_at: null,
    })
    .eq('id', id)
    .select()
    .single()
  if (error) throw error
  return data
}

export async function updateAppointmentStatus(id: string, status: AppointmentStatus): Promise<Appointment> {
  const { data, error } = await supabase.from('appointments').update({ status }).eq('id', id).select().single()
  if (error) throw error
  return data
}
