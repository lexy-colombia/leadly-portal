// Procesa campañas de WhatsApp programadas -- disparado cada minuto por
// pg_cron (ver migración 20260818220002_run_campaigns_cron.sql), nunca
// llamado por un cliente. Mismo patrón que send-appointment-reminders:
// auth con un secreto propio (CRON_REMINDER_SECRET, reusado -- ambos cron
// jobs solo necesitan probar "esta llamada vino del cron de Leadly"),
// service_role para todo el trabajo real.
//
// Ritmo autoimpuesto de ~20 mensajes/minuto por campaña (un tick por minuto
// x 20 destinatarios) -- Meta no expone acá su messaging_limit_tier/quality
// rating real, así que esto es un límite propio para cuidar la reputación
// del número, no algo informado por Meta. Sin reintentos automáticos: un
// destinatario que falla queda marcado y no se vuelve a intentar solo.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { json } from "../_shared/cors.ts";
import { sendWhatsappTemplate } from "../_shared/whatsapp.ts";

const RECIPIENTS_PER_TICK = 20;

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

  // Paso 1: cualquier campaña cuya hora ya llegó pasa de scheduled a
  // sending -- a partir de acá la toma el paso 2, sea en este tick o los
  // siguientes (una campaña grande drena de a RECIPIENTS_PER_TICK por
  // minuto, no de una sola vez).
  const { data: due } = await adminClient
    .from("campaigns")
    .select("id")
    .eq("status", "scheduled")
    .lte("scheduled_at", new Date().toISOString());
  for (const campaign of due ?? []) {
    await adminClient.from("campaigns").update({ status: "sending" }).eq("id", campaign.id);
  }

  // Paso 2: procesar hasta RECIPIENTS_PER_TICK destinatarios por cada
  // campaña que esté en curso.
  const { data: sending } = await adminClient.from("campaigns").select("id, tenant_id, whatsapp_line_id, template_id").eq("status", "sending");

  let processed = 0;
  for (const campaign of sending ?? []) {
    processed += await processCampaignTick(adminClient, campaign);
  }

  return json({ campaignsDue: due?.length ?? 0, campaignsProcessed: sending?.length ?? 0, recipientsProcessed: processed }, 200);
});

async function processCampaignTick(
  adminClient: SupabaseClient,
  campaign: { id: string; tenant_id: string; whatsapp_line_id: string; template_id: string },
): Promise<number> {
  const { data: template } = await adminClient
    .from("whatsapp_message_templates")
    .select("id, name, language, status, body_text, variable_count, header_image_path")
    .eq("id", campaign.template_id)
    .maybeSingle();
  const { data: line } = await adminClient
    .from("whatsapp_lines")
    .select("phone_number_id, status")
    .eq("id", campaign.whatsapp_line_id)
    .maybeSingle();

  // La plantilla o la línea dejaron de estar disponibles después de
  // programar la campaña (Meta la pausó, se desconectó la línea, etc.) --
  // no hay forma de mandar nada, se marca como fallida en vez de reintentar
  // para siempre en cada tick.
  if (!template || template.status !== "APPROVED" || !line || line.status !== "active") {
    await adminClient.from("campaigns").update({ status: "failed" }).eq("id", campaign.id);
    console.error(`Campaign ${campaign.id} failed: template or line unavailable`);
    return 0;
  }

  const { data: accessToken } = await adminClient.rpc("get_whatsapp_line_access_token", { p_line_id: campaign.whatsapp_line_id });
  if (!accessToken) {
    await adminClient.from("campaigns").update({ status: "failed" }).eq("id", campaign.id);
    console.error(`Campaign ${campaign.id} failed: no access token for line ${campaign.whatsapp_line_id}`);
    return 0;
  }

  const { data: recipients } = await adminClient
    .from("campaign_recipients")
    .select("id, contact_phone, contact_name, variables")
    .eq("campaign_id", campaign.id)
    .eq("status", "pending")
    .limit(RECIPIENTS_PER_TICK);

  let sentCount = 0;
  let failedCount = 0;

  for (const recipient of recipients ?? []) {
    const variables = (recipient.variables as string[] | null) ?? [];

    // Find-or-create de la conversación -- mismo criterio que
    // whatsapp-send-template, reimplementado acá porque este loop nunca
    // tiene un caller con su propio JWT, siempre corre como service_role.
    // Se pisa campaign_id aunque la conversación ya existiera: refleja cuál
    // fue el motivo más reciente por el que se le volvió a escribir, que es
    // lo que whatsapp-ai-respond usa para el tema de la IA.
    const { data: existingConversation } = await adminClient
      .from("whatsapp_conversations")
      .select("id")
      .eq("whatsapp_line_id", campaign.whatsapp_line_id)
      .eq("contact_phone", recipient.contact_phone)
      .maybeSingle();

    let conversationId = existingConversation?.id as string | undefined;
    if (conversationId) {
      await adminClient.from("whatsapp_conversations").update({ campaign_id: campaign.id }).eq("id", conversationId);
    } else {
      const { data: created, error: createError } = await adminClient
        .from("whatsapp_conversations")
        .insert({
          tenant_id: campaign.tenant_id,
          whatsapp_line_id: campaign.whatsapp_line_id,
          contact_phone: recipient.contact_phone,
          contact_name: recipient.contact_name,
          // "ia" y no "humano" (a diferencia de whatsapp-send-template, un
          // envío 1:1 disparado por un agente): una campaña es un envío
          // masivo sin agente detrás, así que si el contacto responde debe
          // atenderlo el asistente configurado en la línea, no quedar en
          // modo humano esperando a que alguien la vea.
          mode: "ia",
          campaign_id: campaign.id,
        })
        .select("id")
        .single();
      if (createError || !created) {
        await markRecipientFailed(adminClient, recipient.id, createError?.message ?? "No se pudo crear la conversación.");
        failedCount++;
        continue;
      }
      conversationId = created.id;
    }

    // Mismo criterio que whatsapp-send-template: el encabezado de imagen no
    // queda "horneado" en la plantilla aprobada, Meta exige mandarlo de
    // nuevo en cada envío.
    const components: Record<string, unknown>[] = [];
    if (template.header_image_path) {
      const headerImageUrl = adminClient.storage.from("whatsapp-template-media").getPublicUrl(template.header_image_path).data.publicUrl;
      components.push({ type: "header", parameters: [{ type: "image", image: { link: headerImageUrl } }] });
    }
    if (template.variable_count > 0) {
      components.push({ type: "body", parameters: variables.map((v) => ({ type: "text", text: v })) });
    }

    const sendResult = await sendWhatsappTemplate(line.phone_number_id, accessToken, recipient.contact_phone, template.name, template.language, components);

    if (!sendResult.ok) {
      await markRecipientFailed(adminClient, recipient.id, sendResult.errorMessage ?? "No se pudo enviar la plantilla.");
      failedCount++;
      continue;
    }

    const renderedText = template.body_text.replace(/\{\{(\d+)\}\}/g, (_m: string, n: string) => variables[Number(n) - 1] ?? "");
    // sender_type "agent" exige sender_profile_id (constraint
    // whatsapp_messages_sender_profile_only_for_agent) -- acá no hay ningún
    // agente humano disparando el envío, es el cron, así que "ia" es el valor
    // correcto (mismo criterio que send-appointment-reminders, el otro cron
    // que loguea salientes automáticos sin agente real detrás).
    const { data: message, error: messageError } = await adminClient
      .from("whatsapp_messages")
      .insert({
        conversation_id: conversationId,
        direction: "outbound",
        sender_type: "ia",
        content: renderedText,
        wamid: sendResult.wamid,
      })
      .select("id")
      .single();
    if (messageError) {
      // El envío a Meta ya tuvo éxito (sendResult.wamid existe) -- marcar el
      // destinatario como failed acá mentiría sobre si el cliente recibió el
      // mensaje. Antes este error se descartaba en silencio (solo se leía
      // `data`) y el recipiente quedaba "sent" con whatsapp_message_id null
      // sin ninguna pista de qué pasó -- ahora al menos queda logueado y
      // visible en error_message.
      console.error(`Failed to log whatsapp_messages for campaign ${campaign.id} recipient ${recipient.id}`, messageError);
    }

    await adminClient
      .from("campaign_recipients")
      .update({
        status: "sent",
        whatsapp_message_id: message?.id ?? null,
        sent_at: new Date().toISOString(),
        error_message: messageError ? `Enviado a Meta pero no se pudo registrar el mensaje: ${messageError.message}` : null,
      })
      .eq("id", recipient.id);
    sentCount++;
  }

  if (sentCount > 0 || failedCount > 0) {
    // Increments a mano (no hay trigger que los mantenga) -- solo esta
    // función escribe campaign_recipients, así que no hay condición de
    // carrera real que justifique una función SQL con lock.
    const { data: current } = await adminClient.from("campaigns").select("sent_count, failed_count").eq("id", campaign.id).single();
    await adminClient
      .from("campaigns")
      .update({ sent_count: (current?.sent_count ?? 0) + sentCount, failed_count: (current?.failed_count ?? 0) + failedCount })
      .eq("id", campaign.id);
  }

  const { count: remainingPending } = await adminClient
    .from("campaign_recipients")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", campaign.id)
    .eq("status", "pending");
  if (!remainingPending) {
    // "completed" implicaba éxito aunque los envíos se hayan caído todos
    // (ej. línea sin registrar en Meta) -- una campaña donde no se envió ni
    // un solo mensaje se marca "failed" en vez de "completada" para que no
    // se lea como que todo salió bien.
    const { data: totals } = await adminClient.from("campaigns").select("sent_count, failed_count").eq("id", campaign.id).single();
    const finalStatus = (totals?.sent_count ?? 0) === 0 && (totals?.failed_count ?? 0) > 0 ? "failed" : "completed";
    await adminClient.from("campaigns").update({ status: finalStatus }).eq("id", campaign.id);
  }

  return sentCount + failedCount;
}

async function markRecipientFailed(adminClient: SupabaseClient, recipientId: string, errorMessage: string) {
  await adminClient.from("campaign_recipients").update({ status: "failed", error_message: errorMessage }).eq("id", recipientId);
}

function isCronCaller(authHeader: string): boolean {
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const expected = Deno.env.get("CRON_REMINDER_SECRET");
  return !!expected && token === expected;
}
