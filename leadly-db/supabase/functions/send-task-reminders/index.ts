// Scans tasks that just became overdue (due_date already passed, still
// pendiente/en_proceso, never reminded) and pings the ASSIGNED AGENT by
// WhatsApp, through the tenant's own line, at the phone number they set for
// themselves in "Mi cuenta" (profiles.phone) -- not the contact, unlike
// send-appointment-reminders (a task is internal, the contact has no reason
// to know about it). Triggered every 15 minutes by pg_cron (see migration
// 20260902170000_task_reminders_cron.sql) -- never called by a browser
// client. A single reminder per task the moment it's found overdue (not a
// repeating nag, and not a "heads up, due soon" like appointments get --
// tasks have a deadline, not a meeting time, so "it's now late" is the
// signal that matters).
//
// Same CRON_REMINDER_SECRET auth as send-appointment-reminders/run-campaigns
// (see those functions' own header comments for why a dedicated secret
// instead of SUPABASE_SERVICE_ROLE_KEY).
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

  const { data: tasks, error } = await adminClient
    .from("tasks")
    .select("id, title, due_date, tenant_id, assigned_to, profiles!assigned_to(full_name, phone)")
    .in("status", ["pendiente", "en_proceso"])
    .is("deleted_at", null)
    .is("reminder_sent_at", null)
    .not("assigned_to", "is", null)
    .lt("due_date", new Date().toISOString());

  if (error) {
    console.error("Failed to query overdue tasks", error);
    return json({ error: "Query failed" }, 500);
  }

  // Active WhatsApp line resolved once per tenant, not once per task --
  // several overdue tasks from the same tenant in one scan shouldn't repeat
  // the same lookup.
  const lineCache = new Map<string, { phoneNumberId: string; accessToken: string } | null>();

  let sent = 0;
  for (const task of tasks ?? []) {
    // deno-lint-ignore no-explicit-any
    const agent = task.profiles as any;
    const phone = agent?.phone as string | null | undefined;
    if (!phone) continue; // agent never set a phone in "Mi cuenta" -- nothing to send to, retried on the next scan in case they add one later.

    let line = lineCache.get(task.tenant_id);
    if (line === undefined) {
      const { data: whatsappLine } = await adminClient
        .from("whatsapp_lines")
        .select("id, phone_number_id")
        .eq("tenant_id", task.tenant_id)
        .eq("status", "active")
        .limit(1)
        .maybeSingle();
      if (whatsappLine) {
        const { data: accessToken } = await adminClient.rpc("get_whatsapp_line_access_token", { p_line_id: whatsappLine.id });
        line = accessToken ? { phoneNumberId: whatsappLine.phone_number_id, accessToken } : null;
      } else {
        line = null;
      }
      lineCache.set(task.tenant_id, line);
    }
    if (!line) continue; // no active line/token for this tenant -- skip without stamping, same criterion as send-appointment-reminders.

    const dueDate = new Date(task.due_date).toLocaleString("es-CO", {
      timeZone: "America/Bogota",
      day: "2-digit",
      month: "long",
      hour: "2-digit",
      minute: "2-digit",
    });
    const message = `Hola ${agent?.full_name ?? ""}, tenés una tarea vencida: "${task.title}" (venció el ${dueDate}). Revisala en tu panel de Leadly.`.trim();

    const result = await sendWhatsappText(line.phoneNumberId, line.accessToken, phone, message);
    if (!result.ok) {
      console.error(`Failed to send task reminder for ${task.id}`, result.errorMessage);
    }

    // Stamped either way (success or failure) once we actually attempted the
    // send -- same reasoning as send-appointment-reminders: a broken phone
    // number shouldn't get retried every 15 minutes forever.
    await adminClient.from("tasks").update({ reminder_sent_at: new Date().toISOString() }).eq("id", task.id);
    if (result.ok) sent++;
  }

  return json({ scanned: tasks?.length ?? 0, sent }, 200);
});

function isCronCaller(authHeader: string): boolean {
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const expected = Deno.env.get("CRON_REMINDER_SECRET");
  return !!expected && token === expected;
}
