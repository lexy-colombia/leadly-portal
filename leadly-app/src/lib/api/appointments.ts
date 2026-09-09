import { supabase } from '../supabaseClient'
import type { AppointmentStatus, AppointmentWithContact, Appointment } from '../../types/domain'

/** Tenant-wide appointments in a date range (calendar month view) -- unlike
 * listAppointmentsForContact, this isn't scoped to one contact, so it joins
 * clients for the display name. `rangeEnd` is exclusive. Reads stay direct
 * `.from().select()` -- only writes (below) go through manage-appointment,
 * same criterion already used elsewhere in this app (e.g. Órdenes). */
export async function listAppointmentsForTenantRange(tenantId: string, rangeStart: string, rangeEnd: string): Promise<AppointmentWithContact[]> {
  const { data, error } = await supabase
    .from('appointments')
    .select('*, clients(full_name), assignee:profiles!assigned_to(full_name), opportunities(title)')
    .eq('tenant_id', tenantId)
    .gte('scheduled_at', rangeStart)
    .lt('scheduled_at', rangeEnd)
    .order('scheduled_at', { ascending: true })
  if (error) throw error
  return data.map(({ clients, assignee, opportunities, ...appointment }) => ({
    ...appointment,
    contact_full_name: (clients as { full_name: string } | null)?.full_name ?? null,
    assignee_full_name: (assignee as { full_name: string } | null)?.full_name ?? null,
    opportunity_title: (opportunities as { title: string } | null)?.title ?? null,
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

/** Único punto de escritura real de citas -- reemplaza los
 * `supabase.from('appointments').insert/update(...)` directos que tenía
 * cada una de estas tres funciones (2026-09-09): la misma Edge Function
 * (manage-appointment) que ahora también usa el tool-calling de la IA
 * (_shared/appointments/manageAppointment.ts), para que el cálculo de
 * `ends_at` y la resolución de `whatsapp_line_id` vivan en un solo lugar en
 * vez de repetidos en cada caller -- eso fue justo lo que dejó una cita
 * reagendada por la IA con `ends_at` desactualizado (el trigger que lo
 * calculaba solo cubre INSERT, no UPDATE). */
async function invokeManageAppointment(body: Record<string, unknown>): Promise<Appointment> {
  const { data, error } = await supabase.functions.invoke<Appointment & { error?: string }>('manage-appointment', { body })
  if (error) {
    const context = (error as { context?: Response }).context
    if (context && typeof context.json === 'function') {
      let specificMessage: string | undefined
      try {
        const responseBody = await context.json()
        specificMessage = responseBody?.error
      } catch {
        /* fall through to generic error */
      }
      if (specificMessage) throw new Error(specificMessage)
    }
    throw error
  }
  if (!data || data.error) throw new Error(data?.error ?? 'No se pudo guardar la cita.')
  return data
}

/** `tenantId` se mantiene en la firma para no tener que tocar los 2 lugares
 * que llaman esto (AppointmentFormDrawer.tsx, AppointmentDrawer.tsx) -- el
 * tenant real lo resuelve el servidor de todas formas, del perfil del
 * caller, nunca de lo que mande el cliente. */
export async function createAppointment(
  _tenantId: string,
  contactId: string,
  scheduledAt: string,
  endsAt: string,
  notes: string,
  assignedTo: string | null,
  opportunityId: string | null,
): Promise<Appointment> {
  return invokeManageAppointment({
    action: 'create',
    contact_id: contactId,
    scheduled_at: scheduledAt,
    ends_at: endsAt,
    notes: notes || null,
    assigned_to: assignedTo,
    opportunity_id: opportunityId,
  })
}

/** Reagenda una cita (fecha/hora/duración/contacto/responsable/oportunidad/
 * observaciones). El servidor recalcula ends_at siempre que scheduled_at
 * cambia y limpia reminder_sent_at (mismo criterio que ya tenía esta
 * función) -- ver updateAppointmentCore. */
export async function updateAppointment(
  id: string,
  input: { contactId: string; scheduledAt: string; endsAt: string; notes: string; assignedTo: string | null; opportunityId: string | null },
): Promise<Appointment> {
  return invokeManageAppointment({
    action: 'update',
    appointment_id: id,
    contact_id: input.contactId,
    scheduled_at: input.scheduledAt,
    ends_at: input.endsAt,
    notes: input.notes || null,
    assigned_to: input.assignedTo,
    opportunity_id: input.opportunityId,
  })
}

export async function updateAppointmentStatus(id: string, status: AppointmentStatus): Promise<Appointment> {
  return invokeManageAppointment({ action: 'update', appointment_id: id, status })
}
