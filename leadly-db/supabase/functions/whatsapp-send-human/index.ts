// Sends a manual reply from the tenant panel while a conversation is in
// modo humano. Runs server-side only because it needs the line's decrypted
// Meta access token to call the Graph API -- the actual authorization (this
// caller may act on this conversation) and the message insert both go
// through the caller's own JWT so RLS enforces tenant isolation exactly like
// any other authenticated request, no extra checks reinvented here.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, json } from "../_shared/cors.ts";
import { sendWhatsappImage, sendWhatsappText } from "../_shared/whatsapp.ts";

const IMAGE_PLACEHOLDER_CONTENT = "[Imagen adjunta]";
const ATTACHMENT_SIGNED_URL_TTL_SECONDS = 300;

interface MediaInput {
  storage_path: string;
  mime_type: string;
  size_bytes: number;
}

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

  let body: { conversation_id?: string; content?: string; media?: MediaInput };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const { conversation_id, content, media } = body;
  if (!conversation_id || (!content?.trim() && !media)) {
    return json({ error: "conversation_id and content or media are required" }, 400);
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
    .select("phone_number_id, status")
    .eq("id", conversation.whatsapp_line_id)
    .maybeSingle();
  if (!line) {
    return json({ error: "WhatsApp line not found" }, 404);
  }
  // Explicit check even though a disconnected line also loses its Vault
  // token (delete_whatsapp_line, 20260809180000) -- that would already fail
  // the token lookup below, but this gives a clear reason instead of a
  // generic "no token configured" message.
  if (line.status !== "active") {
    return json({ error: "Esta línea de WhatsApp está desconectada." }, 400);
  }

  const { data: accessToken, error: tokenError } = await callerClient.rpc("get_whatsapp_line_access_token", {
    p_line_id: conversation.whatsapp_line_id,
  });
  if (tokenError || !accessToken) {
    return json({ error: "No hay un access token configurado para esta línea." }, 400);
  }

  const caption = content?.trim() || undefined;
  let sendResult;
  if (media) {
    // Bucket is private (see 20260804000019_crm_attachments migration) --
    // Meta fetches the link itself, so it needs a short-lived signed URL,
    // not the raw storage path. The caller's own JWT is enough to sign it:
    // the same tenant-scoped RLS that let them upload also lets them read it.
    const { data: signedUrlData, error: signedUrlError } = await callerClient.storage
      .from("crm-attachments")
      .createSignedUrl(media.storage_path, ATTACHMENT_SIGNED_URL_TTL_SECONDS);
    if (signedUrlError || !signedUrlData) {
      return json({ error: "No se pudo generar el enlace de la imagen." }, 400);
    }
    sendResult = await sendWhatsappImage(line.phone_number_id, accessToken, conversation.contact_phone, signedUrlData.signedUrl, caption);
  } else {
    sendResult = await sendWhatsappText(line.phone_number_id, accessToken, conversation.contact_phone, caption!);
  }

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
      content: caption ?? IMAGE_PLACEHOLDER_CONTENT,
      wamid: sendResult.wamid,
      media_storage_path: media?.storage_path ?? null,
      media_mime_type: media?.mime_type ?? null,
      media_size_bytes: media?.size_bytes ?? null,
    })
    .select()
    .single();

  if (insertError) {
    return json({ error: insertError.message }, 400);
  }

  return json({ message, sent: true }, 200);
});
