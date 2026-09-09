/** Lógica compartida de citas -- un solo lugar real para el portal (vía la
 * Edge Function pública manage-appointment) y la IA (whatsapp-ai-tools, que
 * llama estas funciones directo por correr ya del lado del servidor, sin
 * HTTP de más entre dos Edge Functions -- mismo patrón que
 * _shared/invoicing/sendInvoiceToDian.ts).
 *
 * Antes cada caller calculaba `ends_at` a su manera -- el portal lo hacía
 * bien (siempre lo mandaba explícito), pero el tool-calling de la IA nunca
 * lo mandaba, confiando en un trigger que solo cubre INSERT
 * (appointments_default_ends_at). Eso produjo un bug real: cuando la IA
 * "reagenda" una cita (mismo tool, hace UPDATE sobre la activa existente en
 * vez de INSERT -- ver bookAppointmentForContact), el trigger no corre y
 * `ends_at` queda con la hora vieja. Acá se calcula una sola vez, siempre,
 * tanto al crear como al actualizar -- no queda ningún camino de escritura
 * de aplicación que pueda dejarlo desactualizado. */
// deno-lint-ignore no-explicit-any
type AdminClient = any;

export interface AppointmentRecord {
  id: string;
  tenant_id: string;
  contact_id: string;
  whatsapp_line_id: string | null;
  scheduled_at: string;
  ends_at: string;
  notes: string | null;
  status: "activa" | "completada" | "cancelada";
  created_by: string | null;
  assigned_to: string | null;
  opportunity_id: string | null;
  reminder_sent_at: string | null;
  created_at: string;
  updated_at: string;
}

const DEFAULT_DURATION_MINUTES = 30;

export function computeEndsAt(scheduledAt: Date, durationMinutes = DEFAULT_DURATION_MINUTES): Date {
  return new Date(scheduledAt.getTime() + durationMinutes * 60000);
}

/** Misma resolución que ya hacía el portal (createAppointment/
 * updateAppointment en lib/api/appointments.ts): la conversación de
 * WhatsApp más reciente de este contacto, para saber por qué línea mandar
 * el recordatorio -- nadie la elige a mano. */
export async function resolveLatestConversationLineId(adminClient: AdminClient, contactId: string): Promise<string | null> {
  const { data } = await adminClient
    .from("whatsapp_conversations")
    .select("whatsapp_line_id")
    .eq("contact_id", contactId)
    .order("last_message_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.whatsapp_line_id ?? null;
}

export interface InsertAppointmentInput {
  tenantId: string;
  contactId: string;
  scheduledAt: Date;
  /** Si viene, tiene prioridad sobre durationMinutes -- el portal ya la
   * calcula (fecha + duración elegida) antes de llamar acá. */
  endsAt?: Date;
  /** Solo la usa la IA (nunca calculó una hora de fin) -- default 30min,
   * mismo valor que ya usaba el trigger appointments_default_ends_at. */
  durationMinutes?: number;
  notes?: string | null;
  createdBy?: string | null;
  assignedTo?: string | null;
  opportunityId?: string | null;
  /** Si viene, se usa tal cual (la IA ya sabe en qué conversación está).
   * Si no, se resuelve por la última conversación del contacto (portal). */
  whatsappLineId?: string | null;
}

export async function insertAppointmentCore(adminClient: AdminClient, input: InsertAppointmentInput): Promise<AppointmentRecord> {
  const endsAt = input.endsAt ?? computeEndsAt(input.scheduledAt, input.durationMinutes);
  const whatsappLineId = input.whatsappLineId !== undefined ? input.whatsappLineId : await resolveLatestConversationLineId(adminClient, input.contactId);

  const { data, error } = await adminClient
    .from("appointments")
    .insert({
      tenant_id: input.tenantId,
      contact_id: input.contactId,
      whatsapp_line_id: whatsappLineId,
      scheduled_at: input.scheduledAt.toISOString(),
      ends_at: endsAt.toISOString(),
      notes: input.notes || null,
      created_by: input.createdBy ?? null,
      assigned_to: input.assignedTo ?? null,
      opportunity_id: input.opportunityId ?? null,
    })
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return data as AppointmentRecord;
}

export interface UpdateAppointmentInput {
  contactId?: string;
  scheduledAt?: Date;
  endsAt?: Date;
  durationMinutes?: number;
  notes?: string | null;
  assignedTo?: string | null;
  opportunityId?: string | null;
  status?: AppointmentRecord["status"];
  whatsappLineId?: string | null;
}

export async function updateAppointmentCore(adminClient: AdminClient, tenantId: string, appointmentId: string, input: UpdateAppointmentInput): Promise<AppointmentRecord> {
  const patch: Record<string, unknown> = {};

  if (input.whatsappLineId !== undefined) {
    patch.whatsapp_line_id = input.whatsappLineId;
  } else if (input.contactId !== undefined) {
    patch.whatsapp_line_id = await resolveLatestConversationLineId(adminClient, input.contactId);
  }
  if (input.contactId !== undefined) patch.contact_id = input.contactId;

  // ends_at SIEMPRE se recalcula acá cuando scheduled_at cambia -- ver
  // comentario de cabecera, esto es lo que corrige el bug de raíz. El
  // portal manda scheduledAt+endsAt juntos siempre (el formulario tiene los
  // dos campos); la IA reagendando solo manda scheduledAt -- en ese caso se
  // preserva la duración que la cita ya tenía en vez de asumir 30 minutos
  // (no hay forma de saber la duración real sin leer la fila actual). No
  // cubre "cambiar solo la duración sin tocar scheduled_at" -- ningún
  // caller de hoy necesita eso.
  if (input.scheduledAt !== undefined) {
    const scheduledAt = input.scheduledAt;
    let endsAt: Date;
    if (input.endsAt !== undefined) {
      endsAt = input.endsAt;
    } else if (input.durationMinutes !== undefined) {
      endsAt = computeEndsAt(scheduledAt, input.durationMinutes);
    } else {
      const { data: current, error: currentError } = await adminClient
        .from("appointments")
        .select("scheduled_at, ends_at")
        .eq("id", appointmentId)
        .eq("tenant_id", tenantId)
        .maybeSingle();
      if (currentError) throw new Error(currentError.message);
      if (!current) throw new Error("Cita no encontrada.");
      const durationMs = new Date(current.ends_at).getTime() - new Date(current.scheduled_at).getTime();
      endsAt = new Date(scheduledAt.getTime() + durationMs);
    }
    patch.scheduled_at = scheduledAt.toISOString();
    patch.ends_at = endsAt.toISOString();
    // Reagendar reactiva el recordatorio -- si ya se había mandado uno para
    // el horario viejo, no corresponde para el nuevo (mismo criterio que ya
    // tenía updateAppointment del portal).
    patch.reminder_sent_at = null;
  }

  if (input.notes !== undefined) patch.notes = input.notes || null;
  if (input.assignedTo !== undefined) patch.assigned_to = input.assignedTo;
  if (input.opportunityId !== undefined) patch.opportunity_id = input.opportunityId;
  if (input.status !== undefined) patch.status = input.status;

  const { data, error } = await adminClient
    .from("appointments")
    .update(patch)
    .eq("id", appointmentId)
    .eq("tenant_id", tenantId)
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return data as AppointmentRecord;
}

export async function cancelAppointmentCore(adminClient: AdminClient, tenantId: string, appointmentId: string): Promise<AppointmentRecord> {
  return updateAppointmentCore(adminClient, tenantId, appointmentId, { status: "cancelada" });
}

// ---- Wrappers específicos del contrato actual de la IA (whatsapp-ai-tools) ----
// Deliberadamente separados de las primitivas de arriba -- ver comentario en
// bookAppointmentForContact.

export async function findActiveUpcomingAppointment(adminClient: AdminClient, tenantId: string, contactId: string): Promise<{ id: string } | null> {
  const { data, error } = await adminClient
    .from("appointments")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("contact_id", contactId)
    .eq("status", "activa")
    .gte("scheduled_at", new Date().toISOString())
    .order("scheduled_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

/** La oportunidad abierta más reciente del contacto, si tiene una -- mismo
 * criterio que ya usa create_opportunity/get_opportunity_status
 * (whatsapp-ai-tools/index.ts) para resolver "la oportunidad de este
 * contacto" sin que el modelo tenga que conocer ni pasar ningún id (nunca
 * ve un uuid de oportunidad). Filtra por status='open' a propósito -- acá
 * el uso es "a qué negociación en curso pertenece esta cita", así que una
 * ganada/perdida no cuenta aunque sea la más reciente. */
export async function resolveOpenOpportunityId(adminClient: AdminClient, tenantId: string, contactId: string): Promise<string | null> {
  const { data } = await adminClient
    .from("opportunities")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("contact_id", contactId)
    .eq("status", "open")
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.id ?? null;
}

export interface BookAppointmentForContactInput {
  tenantId: string;
  contactId: string;
  whatsappLineId: string | null;
  scheduledAt: Date;
  /** Solo si el cliente la mencionó -- ver aiTools.ts. Sin esto, 30 minutos
   * por defecto (mismo criterio que ya tenía el trigger de la base). */
  durationMinutes?: number;
  notes: string | null;
}

/** Mismo comportamiento idempotente que ya tenía book_appointment: si el
 * contacto ya tiene una cita activa futura, la reagenda (UPDATE) en vez de
 * crear una segunda -- un modelo sin memoria entre turnos puede llamar esta
 * tool dos veces para la misma intención (bug real encontrado en vivo
 * 2026-08-14, ver whatsapp-ai-tools/index.ts). Deliberadamente separado de
 * insertAppointmentCore/updateAppointmentCore en vez de ser el
 * comportamiento default de ambas: un humano creando una cita nueva desde
 * el Calendario nunca debería fusionarse en silencio con una que ya tenía
 * -- esto es específicamente un parche para la IA.
 *
 * Vincula la cita a la oportunidad abierta del contacto automáticamente
 * (pedido explícito del usuario, 2026-09-09) -- se resuelve de nuevo en
 * cada llamada, tanto al crear como al reagendar, para que siempre refleje
 * la oportunidad abierta ACTUAL (si cambió entre el primer agendamiento y
 * un reagendado posterior, la cita sigue la más reciente en vez de quedarse
 * con la que tenía guardada). */
export async function bookAppointmentForContact(adminClient: AdminClient, input: BookAppointmentForContactInput): Promise<AppointmentRecord> {
  const [existing, opportunityId] = await Promise.all([
    findActiveUpcomingAppointment(adminClient, input.tenantId, input.contactId),
    resolveOpenOpportunityId(adminClient, input.tenantId, input.contactId),
  ]);
  if (existing) {
    return updateAppointmentCore(adminClient, input.tenantId, existing.id, {
      scheduledAt: input.scheduledAt,
      durationMinutes: input.durationMinutes,
      notes: input.notes,
      whatsappLineId: input.whatsappLineId,
      opportunityId,
    });
  }
  return insertAppointmentCore(adminClient, {
    tenantId: input.tenantId,
    contactId: input.contactId,
    scheduledAt: input.scheduledAt,
    durationMinutes: input.durationMinutes,
    notes: input.notes,
    whatsappLineId: input.whatsappLineId,
    opportunityId,
  });
}

export async function listActiveUpcomingAppointmentsForContact(
  adminClient: AdminClient,
  tenantId: string,
  contactId: string,
): Promise<Pick<AppointmentRecord, "id" | "scheduled_at" | "notes" | "status">[]> {
  const { data, error } = await adminClient
    .from("appointments")
    .select("id, scheduled_at, notes, status")
    .eq("tenant_id", tenantId)
    .eq("contact_id", contactId)
    .eq("status", "activa")
    .gte("scheduled_at", new Date().toISOString())
    .order("scheduled_at", { ascending: true });
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function cancelActiveAppointmentForContact(adminClient: AdminClient, tenantId: string, contactId: string): Promise<AppointmentRecord> {
  const existing = await findActiveUpcomingAppointment(adminClient, tenantId, contactId);
  if (!existing) throw new Error("Este cliente no tiene ninguna cita activa.");
  return cancelAppointmentCore(adminClient, tenantId, existing.id);
}
