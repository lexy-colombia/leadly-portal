// Scans crm_appointments for anything scheduled ~1h out that hasn't been
// reminded yet, and sends the contact a WhatsApp message through the
// conversation's own line. Triggered every 5 minutes by pg_cron (see
// migration 20260804000004_appointment_reminder_cron.sql) -- never called by
// a browser client. A 10-minute scan window (55-65 min out) with a 5-minute
// cron tick guarantees every appointment is seen exactly once without a
// separate "already scanned" lock.
//
// Auth uses its own dedicated CRON_REMINDER_SECRET (set via `supabase
// secrets set`, mirrored into Vault for the Postgres cron function to read)
// instead of SUPABASE_SERVICE_ROLE_KEY -- the platform can silently rotate
// the format of the injected service role key (legacy JWT vs sb_secret_...),
// which would break a hardcoded copy stored in Vault for the cron job. A
// secret only Leadly's own code ever sets or reads is immune to that.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { json } from "../_shared/cors.ts";
import { sendWhatsappText } from "../_shared/whatsapp.ts";

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!isCronCaller(authHeader)) {
    return json({ error: "Forbidden" }, 403);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const adminClient = createClient(supabaseUrl, serviceRoleKey);

  const windowStart = new Date(Date.now() + 55 * 60 * 1000).toISOString();
  const windowEnd = new Date(Date.now() + 65 * 60 * 1000).toISOString();

  const { data: appointments, error } = await adminClient
    .from("crm_appointments")
    .select("id, contact_id, whatsapp_line_id, scheduled_at, tenant_id, crm_contacts(full_name, phone)")
    .eq("status", "activa")
    .is("reminder_sent_at", null)
    .gte("scheduled_at", windowStart)
    .lte("scheduled_at", windowEnd);

  if (error) {
    console.error("Failed to query due appointments", error);
    return json({ error: "Query failed" }, 500);
  }

  let sent = 0;
  for (const appt of appointments ?? []) {
    // deno-lint-ignore no-explicit-any
    const contact = appt.crm_contacts as any;
    if (!contact) continue;

    let lineId = appt.whatsapp_line_id as string | null;
    if (!lineId) {
      const { data: conv } = await adminClient
        .from("whatsapp_conversations")
        .select("whatsapp_line_id")
        .eq("contact_id", appt.contact_id)
        .order("last_message_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      lineId = conv?.whatsapp_line_id ?? null;
    }
    if (!lineId) continue;

    const { data: line } = await adminClient.from("whatsapp_lines").select("phone_number_id, status").eq("id", lineId).maybeSingle();
    if (!line || line.status !== "active") continue;

    const { data: accessToken } = await adminClient.rpc("get_whatsapp_line_access_token", { p_line_id: lineId });
    if (!accessToken) continue;

    const time = new Date(appt.scheduled_at).toLocaleString("es-CO", {
      timeZone: "America/Bogota",
      day: "2-digit",
      month: "long",
      hour: "2-digit",
      minute: "2-digit",
    });
    const message = `Hola ${contact.full_name || ""}, te recordamos tu cita agendada para el ${time}. ¡Te esperamos!`.trim();

    const result = await sendWhatsappText(line.phone_number_id, accessToken, contact.phone, message);

    const { data: conv } = await adminClient
      .from("whatsapp_conversations")
      .select("id")
      .eq("contact_id", appt.contact_id)
      .eq("whatsapp_line_id", lineId)
      .maybeSingle();

    // Only record the reminder in the conversation's history if it actually
    // reached the contact -- a failed send left no trace for them, so it
    // shouldn't look like Leadly said something. reminder_sent_at is still
    // stamped either way (success or failure) so a broken line doesn't get
    // retried every 5 minutes -- that's a separate concern from what shows
    // up in the chat.
    if (conv && result.ok) {
      await adminClient.from("whatsapp_messages").insert({
        conversation_id: conv.id,
        direction: "outbound",
        sender_type: "ia",
        content: message,
        wamid: result.wamid,
      });
    } else if (!result.ok) {
      console.error(`Failed to send appointment reminder for ${appt.id}`, result.errorMessage);
    }

    await adminClient.from("crm_appointments").update({ reminder_sent_at: new Date().toISOString() }).eq("id", appt.id);
    if (result.ok) sent++;
  }

  return json({ scanned: appointments?.length ?? 0, sent }, 200);
});

function isCronCaller(authHeader: string): boolean {
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const expected = Deno.env.get("CRON_REMINDER_SECRET");
  return !!expected && token === expected;
}
