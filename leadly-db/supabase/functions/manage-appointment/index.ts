/** Único punto de escritura real para `appointments` -- reemplaza los
 * `supabase.from('appointments').insert/update(...)` que el portal hacía
 * directo desde el navegador (lib/api/appointments.ts) y la lógica inline
 * que tenía el tool-calling de la IA (whatsapp-ai-tools/index.ts). Los dos
 * ahora llaman las mismas primitivas de _shared/appointments/
 * manageAppointment.ts -- el portal por acá (HTTP, tiene que ser así, corre
 * en el navegador), la IA directo por import (ya corre server-side, no
 * tiene sentido que le pegue por HTTP a otra Edge Function).
 *
 * Un solo POST con `action` en el body (create/update/cancel) -- mismo
 * patrón que dian-submit/create-order, no verbos HTTP como router (sería la
 * única función del proyecto con esa convención).
 *
 * Auth: JWT del propio caller (mismo patrón que create-order) -- tenant_id
 * sale de profiles.tenant_id del caller, nunca de lo que mande el body.
 * contact_id/assigned_to/opportunity_id se validan contra ese tenant antes
 * de usarlos (vía callerClient, que respeta RLS) -- nunca confiar en un id
 * sin comprobar dueño primero. */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, json } from "../_shared/cors.ts";
import { insertAppointmentCore, updateAppointmentCore, cancelAppointmentCore, type AppointmentRecord } from "../_shared/appointments/manageAppointment.ts";

interface ManageAppointmentBody {
  action?: "create" | "update" | "cancel";
  appointment_id?: string;
  contact_id?: string;
  scheduled_at?: string;
  ends_at?: string;
  duration_minutes?: number;
  notes?: string | null;
  assigned_to?: string | null;
  opportunity_id?: string | null;
  status?: AppointmentRecord["status"];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "Missing Authorization header" }, 401);

  let body: ManageAppointmentBody;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  if (!body.action) return json({ error: "action es requerido" }, 400);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const callerClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });

  const {
    data: { user: caller },
    error: callerError,
  } = await callerClient.auth.getUser();
  if (callerError || !caller) return json({ error: "Invalid session" }, 401);

  const { data: profile } = await callerClient.from("profiles").select("tenant_id").eq("id", caller.id).maybeSingle();
  if (!profile?.tenant_id) return json({ error: "No se pudo resolver el tenant del usuario." }, 403);
  const tenantId = profile.tenant_id as string;

  const adminClient = createClient(supabaseUrl, serviceRoleKey);

  // RLS de cada tabla ya aísla por tenant -- si el id es de otro tenant,
  // esto viene null, igual que "no existe" (mismo criterio que
  // resolveOrderAddress del storefront, admin-create-tenant-user, etc.).
  async function assertOwnedByTenant(table: "clients" | "profiles" | "opportunities", id: string, label: string): Promise<void> {
    const { data } = await callerClient.from(table).select("id").eq("id", id).maybeSingle();
    if (!data) throw new Error(`${label} no encontrado.`);
  }

  function parseDate(value: string, field: string): Date {
    const parsed = new Date(value);
    if (isNaN(parsed.getTime())) throw new Error(`${field} no es una fecha válida.`);
    return parsed;
  }

  try {
    if (body.action === "create") {
      if (!body.contact_id) throw new Error("contact_id es requerido.");
      if (!body.scheduled_at) throw new Error("scheduled_at es requerido.");
      await assertOwnedByTenant("clients", body.contact_id, "Cliente");
      if (body.assigned_to) await assertOwnedByTenant("profiles", body.assigned_to, "Agente");
      if (body.opportunity_id) await assertOwnedByTenant("opportunities", body.opportunity_id, "Oportunidad");

      const scheduledAt = parseDate(body.scheduled_at, "scheduled_at");
      const appointment = await insertAppointmentCore(adminClient, {
        tenantId,
        contactId: body.contact_id,
        scheduledAt,
        endsAt: body.ends_at ? parseDate(body.ends_at, "ends_at") : undefined,
        durationMinutes: body.duration_minutes,
        notes: body.notes,
        createdBy: caller.id,
        assignedTo: body.assigned_to ?? null,
        opportunityId: body.opportunity_id ?? null,
      });
      return json(appointment);
    }

    if (body.action === "update") {
      if (!body.appointment_id) throw new Error("appointment_id es requerido.");
      if (body.contact_id) await assertOwnedByTenant("clients", body.contact_id, "Cliente");
      if (body.assigned_to) await assertOwnedByTenant("profiles", body.assigned_to, "Agente");
      if (body.opportunity_id) await assertOwnedByTenant("opportunities", body.opportunity_id, "Oportunidad");

      const appointment = await updateAppointmentCore(adminClient, tenantId, body.appointment_id, {
        contactId: body.contact_id,
        scheduledAt: body.scheduled_at !== undefined ? parseDate(body.scheduled_at, "scheduled_at") : undefined,
        endsAt: body.ends_at !== undefined ? parseDate(body.ends_at, "ends_at") : undefined,
        durationMinutes: body.duration_minutes,
        notes: body.notes,
        assignedTo: body.assigned_to,
        opportunityId: body.opportunity_id,
        status: body.status,
      });
      return json(appointment);
    }

    if (body.action === "cancel") {
      if (!body.appointment_id) throw new Error("appointment_id es requerido.");
      const appointment = await cancelAppointmentCore(adminClient, tenantId, body.appointment_id);
      return json(appointment);
    }

    return json({ error: `action inválida: ${body.action}` }, 400);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
