// Sends an approved WhatsApp template (HSM) to start or reactivate a
// conversation -- the only business-initiated message Meta allows outside
// the 24h customer-service window. Sibling to whatsapp-send-human, not a
// modification of it: the payload shape differs (type: "template" vs
// "text") and, critically, this function must work even when no
// whatsapp_conversations row exists yet (a genuinely new contact), which
// whatsapp-send-human hard-requires via a 404 on missing conversation.
//
// Runs entirely with the caller's own JWT, same pattern as
// whatsapp-send-human -- RLS enforces tenant isolation on every read/write,
// no service_role needed.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, json } from "../_shared/cors.ts";
import { sendWhatsappTemplate } from "../_shared/whatsapp.ts";

interface RequestBody {
  tenant_id?: string;
  whatsapp_line_id?: string;
  contact_id?: string;
  contact_phone?: string;
  contact_name?: string;
  template_id?: string;
  variables?: string[];
}

function renderBody(bodyText: string, variables: string[]): string {
  return bodyText.replace(/\{\{(\d+)\}\}/g, (_match, n) => variables[Number(n) - 1] ?? "");
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

  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const { tenant_id: tenantId, whatsapp_line_id: whatsappLineId, contact_id: contactId, contact_phone: contactPhone, contact_name: contactName, template_id: templateId, variables } = body;
  if (!tenantId || !whatsappLineId || !contactPhone || !templateId) {
    return json({ error: "tenant_id, whatsapp_line_id, contact_phone y template_id son obligatorios" }, 400);
  }
  const vars = variables ?? [];

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

  const { data: template } = await callerClient
    .from("whatsapp_message_templates")
    .select("id, name, language, status, body_text, variable_count, header_image_path")
    .eq("id", templateId)
    .maybeSingle();
  if (!template) {
    return json({ error: "Plantilla no encontrada" }, 404);
  }
  if (template.status !== "APPROVED") {
    return json({ error: "La plantilla todavía no está aprobada por Meta." }, 400);
  }
  if (vars.length !== template.variable_count) {
    return json({ error: `La plantilla espera ${template.variable_count} variable(s), se recibieron ${vars.length}.` }, 400);
  }

  const { data: line } = await callerClient
    .from("whatsapp_lines")
    .select("phone_number_id, status")
    .eq("id", whatsappLineId)
    .maybeSingle();
  if (!line) {
    return json({ error: "WhatsApp line not found" }, 404);
  }
  if (line.status !== "active") {
    return json({ error: "Esta línea de WhatsApp está desconectada." }, 400);
  }

  const { data: accessToken, error: tokenError } = await callerClient.rpc("get_whatsapp_line_access_token", {
    p_line_id: whatsappLineId,
  });
  if (tokenError || !accessToken) {
    return json({ error: "No hay un access token configurado para esta línea." }, 400);
  }

  // Find-or-create: mismo upsert que createConversation en el frontend
  // (leadly-app/src/lib/api/conversations.ts), reimplementado acá porque
  // esta función tiene que poder llamarse sola sin depender de que el
  // drawer ya haya creado la fila -- un contacto nuevo nunca la tiene.
  const { data: existingConversation, error: existingError } = await callerClient
    .from("whatsapp_conversations")
    .select("*")
    .eq("whatsapp_line_id", whatsappLineId)
    .eq("contact_phone", contactPhone)
    .maybeSingle();
  if (existingError) return json({ error: existingError.message }, 400);

  let conversation = existingConversation;
  if (!conversation) {
    const { data: created, error: createError } = await callerClient
      .from("whatsapp_conversations")
      .insert({
        tenant_id: tenantId,
        whatsapp_line_id: whatsappLineId,
        contact_id: contactId ?? null,
        contact_phone: contactPhone,
        contact_name: contactName ?? null,
        mode: "humano",
      })
      .select()
      .single();
    if (createError) return json({ error: createError.message }, 400);
    conversation = created;
  }

  // El encabezado de imagen no queda "horneado" en la plantilla aprobada --
  // a diferencia de los botones estáticos, Meta exige mandar el media de
  // nuevo en cada envío (mismo motivo por el que send_attachment de la IA
  // manda un image.link en vez de confiar en algo ya subido antes).
  const components: Record<string, unknown>[] = [];
  if (template.header_image_path) {
    const headerImageUrl = callerClient.storage.from("whatsapp-template-media").getPublicUrl(template.header_image_path).data.publicUrl;
    components.push({ type: "header", parameters: [{ type: "image", image: { link: headerImageUrl } }] });
  }
  if (template.variable_count > 0) {
    components.push({ type: "body", parameters: vars.map((v) => ({ type: "text", text: v })) });
  }

  const sendResult = await sendWhatsappTemplate(line.phone_number_id, accessToken, contactPhone, template.name, template.language, components);
  if (!sendResult.ok) {
    return json({ error: sendResult.errorMessage ?? "No se pudo enviar la plantilla." }, 400);
  }

  const renderedText = renderBody(template.body_text, vars);
  const { data: message, error: insertError } = await callerClient
    .from("whatsapp_messages")
    .insert({
      conversation_id: conversation.id,
      direction: "outbound",
      sender_type: "agent",
      sender_profile_id: caller.id,
      content: renderedText,
      wamid: sendResult.wamid,
    })
    .select()
    .single();
  if (insertError) return json({ error: insertError.message }, 400);

  return json({ conversation, message }, 200);
});
