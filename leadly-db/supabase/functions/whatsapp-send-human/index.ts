// Sends a manual reply from the tenant panel while a conversation is in
// modo humano. Runs server-side only because it needs the line's decrypted
// Meta access token to call the Graph API -- the actual authorization (this
// caller may act on this conversation) and the message insert both go
// through the caller's own JWT so RLS enforces tenant isolation exactly like
// any other authenticated request, no extra checks reinvented here.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, json } from "../_shared/cors.ts";
import { sendWhatsappText } from "../_shared/whatsapp.ts";

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

  let body: { conversation_id?: string; content?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const { conversation_id, content } = body;
  if (!conversation_id || !content?.trim()) {
    return json({ error: "conversation_id and content are required" }, 400);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const callerClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });

  const {
    data: { user: caller },
    error: callerError,
  } = await callerClient.auth.getUser();
  if (callerError || !caller) {
    return json({ error: "Invalid session" }, 401);
  }

  // RLS on whatsapp_conversations already scopes this to the caller's own
  // tenant -- a conversation belonging to someone else's tenant simply comes
  // back null here, same as "not found".
  const { data: conversation } = await callerClient
    .from("whatsapp_conversations")
    .select("id, whatsapp_line_id, contact_phone, mode")
    .eq("id", conversation_id)
    .maybeSingle();

  if (!conversation) {
    return json({ error: "Conversation not found" }, 404);
  }
  if (conversation.mode !== "humano") {
    return json({ error: "La conversación no está en modo humano" }, 400);
  }

  const { data: line } = await callerClient
    .from("whatsapp_lines")
    .select("phone_number_id")
    .eq("id", conversation.whatsapp_line_id)
    .maybeSingle();
  if (!line) {
    return json({ error: "WhatsApp line not found" }, 404);
  }

  const { data: accessToken, error: tokenError } = await callerClient.rpc("get_whatsapp_line_access_token", {
    p_line_id: conversation.whatsapp_line_id,
  });
  if (tokenError || !accessToken) {
    return json({ error: "No hay un access token configurado para esta línea." }, 400);
  }

  const sendResult = await sendWhatsappText(line.phone_number_id, accessToken, conversation.contact_phone, content.trim());

  // A message that never reached the contact shouldn't show up in the chat
  // as if it had -- surface the failure to the agent instead so they know to
  // retry (the draft stays in their input box, see leadly-app ChatPanel).
  if (!sendResult.ok) {
    return json({ error: sendResult.errorMessage ?? "No se pudo enviar el mensaje." }, 400);
  }

  const { data: message, error: insertError } = await callerClient
    .from("whatsapp_messages")
    .insert({
      conversation_id: conversation.id,
      direction: "outbound",
      sender_type: "agent",
      sender_profile_id: caller.id,
      content: content.trim(),
      wamid: sendResult.wamid,
    })
    .select()
    .single();

  if (insertError) {
    return json({ error: insertError.message }, 400);
  }

  return json({ message, sent: true }, 200);
});
