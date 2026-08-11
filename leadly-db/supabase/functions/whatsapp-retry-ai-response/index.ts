// Manual "Reintentar respuesta de IA" from the chat -- for when a
// conversation gets stuck with no AI reply (a transient failure in
// whatsapp-ai-respond, the assistant was inactive at the time, etc.) and the
// tenant doesn't want to wait. Thin wrapper: does its own authorization
// check using the caller's own JWT (RLS naturally scopes the conversation
// lookup to their tenant), then re-invokes whatsapp-ai-respond with the
// service role key -- the exact same call whatsapp-webhook makes, just
// triggered by a person instead of an inbound message.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, json } from "../_shared/cors.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return json({ error: "Missing Authorization header" }, 401);
  }

  let body: { conversation_id?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  if (!body.conversation_id) {
    return json({ error: "conversation_id is required" }, 400);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const callerClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });

  const {
    data: { user: caller },
    error: callerError,
  } = await callerClient.auth.getUser();
  if (callerError || !caller) {
    return json({ error: "Invalid session" }, 401);
  }

  // RLS scopes this to the caller's own tenant -- a conversation belonging
  // to someone else's tenant simply comes back null, same as "not found".
  const { data: conversation } = await callerClient
    .from("whatsapp_conversations")
    .select("id, mode")
    .eq("id", body.conversation_id)
    .maybeSingle();
  if (!conversation) {
    return json({ error: "Conversation not found" }, 404);
  }
  if (conversation.mode !== "ia") {
    return json({ error: "La conversación no está en modo IA." }, 400);
  }

  const resp = await fetch(`${supabaseUrl}/functions/v1/whatsapp-ai-respond`, {
    method: "POST",
    headers: { Authorization: `Bearer ${serviceRoleKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ conversation_id: conversation.id }),
  });
  const data = await resp.json().catch(() => null);

  if (!resp.ok) {
    return json({ error: "No se pudo generar la respuesta. Intenta de nuevo en un momento." }, 502);
  }
  if (data?.skipped) {
    const reasons: Record<string, string> = {
      not_in_ia_mode: "La conversación ya no está en modo IA.",
      line_not_active: "La línea de WhatsApp no está activa.",
      assistant_inactive: "El asistente de IA está desactivado para esta línea.",
    };
    return json({ error: reasons[data.reason] ?? "No se generó una respuesta." }, 400);
  }
  if (data?.sent === false) {
    return json({ error: "La IA respondió pero el mensaje no se pudo entregar por WhatsApp." }, 502);
  }

  return json({ ok: true }, 200);
});
