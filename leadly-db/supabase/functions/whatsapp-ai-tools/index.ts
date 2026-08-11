// The "executor service" for AI tool-calling -- deliberately separate from
// whatsapp-ai-respond (which only talks to the LLM), same split as
// tania-functions in the seeri project: one place that knows how to
// generate a response, another that knows how to actually act on the
// database, so the LLM-facing loop never has direct DB access itself.
// Internal-only: invoked by whatsapp-ai-respond using the service role key.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { json } from "../_shared/cors.ts";
import { AI_TOOLS, isToolAllowed } from "../_shared/aiTools.ts";
import { sendWhatsappImage } from "../_shared/whatsapp.ts";

const ATTACHMENT_SIGNED_URL_TTL_SECONDS = 300;
const CATALOG_SEARCH_LIMIT = 15;
const CATEGORY_LIST_LIMIT = 5;
const CATEGORY_TOP_PRODUCTS_LIMIT = 5;

const PQR_TYPES = ["peticion", "queja", "reclamo"];
const PQR_STATUSES = ["abierto", "en_proceso", "resuelto", "cerrado"];
const OPPORTUNITY_PRIORITIES = ["baja", "media", "alta"];
const LEAD_STAGES = ["lead", "contactado", "negociacion", "cliente", "perdido"];

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!isServiceRoleCaller(authHeader)) {
    return json({ error: "Forbidden" }, 403);
  }

  let body: { function_name?: string; parameters?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const functionName = body.function_name;
  const parameters = body.parameters ?? {};
  if (!functionName) {
    return json({ error: "function_name is required" }, 400);
  }

  // tenant_id/conversation_id/contact_id are injected by whatsapp-ai-respond
  // (never taken from what the model itself claims) -- see _shared/aiTools.ts.
  const tenantId = parameters.tenant_id as string | undefined;
  const conversationId = parameters.conversation_id as string | undefined;
  const contactId = parameters.contact_id as string | undefined;
  if (!tenantId || !conversationId) {
    return json({ error: "tenant_id and conversation_id are required" }, 400);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const adminClient = createClient(supabaseUrl, serviceRoleKey);

  let result: unknown = null;
  let errorMessage: string | null = null;
  try {
    if (!AI_TOOLS.some((tool) => tool.name === functionName)) {
      throw new Error(`Unknown function_name: ${functionName}`);
    }
    // Defense in depth: whatsapp-ai-respond only ever offers the model tools
    // from enabled skills, but this function is invoked purely by
    // function_name/parameters with no other trust signal -- re-check here
    // too, in case that ever drifts (a stale cached tool list, a bug), so a
    // disabled skill's tool can never actually execute even if requested.
    const enabledSkillKeys = await getEnabledSkillKeys(adminClient, conversationId);
    if (!isToolAllowed(functionName, enabledSkillKeys)) {
      throw new Error(`Tool ${functionName} is not enabled for this assistant`);
    }
    result = await executeTool(adminClient, functionName, tenantId, conversationId, contactId, parameters);
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : "Unknown error executing tool";
  }

  await adminClient.from("ai_tool_executions").insert({
    tenant_id: tenantId,
    conversation_id: conversationId,
    function_name: functionName,
    parameters,
    result: errorMessage ? null : result,
    error_message: errorMessage,
  });

  if (errorMessage) return json({ error: errorMessage }, 200);
  return json({ result }, 200);
});

/** Same pattern as whatsapp-ai-respond's own copy -- compares the bearer
 * token directly against this function's SUPABASE_SERVICE_ROLE_KEY instead
 * of decoding it as a JWT (the newer sb_secret_... key format isn't one). */
function isServiceRoleCaller(authHeader: string): boolean {
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const expected = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  return !!expected && token === expected;
}

/** Resolves the conversation's whatsapp_line -> ai_assistant -> enabled
 * skill keys. Empty set (not an error) if anything along that chain is
 * missing -- executeTool's caller then rejects the tool call the same way
 * it would for a genuinely disabled skill. */
// deno-lint-ignore no-explicit-any
async function getEnabledSkillKeys(adminClient: any, conversationId: string): Promise<Set<string>> {
  const { data: conversation } = await adminClient
    .from("whatsapp_conversations")
    .select("whatsapp_line_id")
    .eq("id", conversationId)
    .maybeSingle();
  if (!conversation) return new Set();

  const { data: line } = await adminClient
    .from("whatsapp_lines")
    .select("ai_assistant_id")
    .eq("id", conversation.whatsapp_line_id)
    .maybeSingle();
  if (!line?.ai_assistant_id) return new Set();

  const { data: assistant } = await adminClient
    .from("ai_assistants")
    .select("id")
    .eq("id", line.ai_assistant_id)
    .maybeSingle();
  if (!assistant) return new Set();

  const { data: rows } = await adminClient.from("ai_assistant_skills").select("skill_key").eq("ai_assistant_id", assistant.id);
  return new Set((rows ?? []).map((r: { skill_key: string }) => r.skill_key));
}

// deno-lint-ignore no-explicit-any
async function executeTool(
  adminClient: any,
  functionName: string,
  tenantId: string,
  conversationId: string,
  contactId: string | undefined,
  parameters: Record<string, unknown>,
): Promise<unknown> {
  switch (functionName) {
    case "create_pqr": {
      if (!contactId) throw new Error("No hay un contacto vinculado a esta conversación.");
      const type = String(parameters.type ?? "");
      if (!PQR_TYPES.includes(type)) throw new Error(`type inválido: ${type}`);
      const subject = String(parameters.subject ?? "").trim();
      if (!subject) throw new Error("subject es requerido");
      const description = String(parameters.description ?? "").trim();

      // `code` is assigned by the crm_pqrs trigger (see the pqr_codes
      // migration) -- never set it here, just read it back so it can be
      // relayed to the customer ("tu caso quedó registrado como PQR-7").
      const { data, error } = await adminClient
        .from("crm_pqrs")
        .insert({ tenant_id: tenantId, contact_id: contactId, type, subject, description: description || null, created_by_ai: true })
        .select("id, code, type, subject, status")
        .single();
      if (error) throw new Error(error.message);

      await linkPendingAttachment(adminClient, tenantId, "pqr_id", data.id, parameters);
      return data;
    }

    case "create_note": {
      if (!contactId) throw new Error("No hay un contacto vinculado a esta conversación.");
      const content = String(parameters.content ?? "").trim();
      if (!content) throw new Error("content es requerido");

      const { data, error } = await adminClient
        .from("crm_notes")
        .insert({ tenant_id: tenantId, contact_id: contactId, content, created_by_ai: true })
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      return data;
    }

    case "add_pqr_update": {
      const pqr = await resolveLatestPqr(adminClient, tenantId, contactId);
      const content = String(parameters.content ?? "").trim();
      if (!content) throw new Error("content es requerido");

      const { data, error } = await adminClient
        .from("crm_pqr_updates")
        .insert({ tenant_id: tenantId, pqr_id: pqr.id, content, created_by_ai: true })
        .select("id, seq")
        .single();
      if (error) throw new Error(error.message);

      await linkPendingAttachment(adminClient, tenantId, "pqr_update_id", data.id, parameters);
      return { ...data, pqr_id: pqr.id, pqr_code: pqr.code };
    }

    case "update_pqr_status": {
      const pqr = await resolveLatestPqr(adminClient, tenantId, contactId);
      const status = String(parameters.status ?? "");
      if (!PQR_STATUSES.includes(status)) throw new Error(`status inválido: ${status}`);

      const { error: updateError } = await adminClient.from("crm_pqrs").update({ status }).eq("id", pqr.id);
      if (updateError) throw new Error(updateError.message);

      // Leaves a visible trace in the PQR's own thread instead of only
      // living in ai_tool_executions -- an agent reading the case sees why
      // its status changed without having to check a separate audit log.
      await adminClient
        .from("crm_pqr_updates")
        .insert({ tenant_id: tenantId, pqr_id: pqr.id, content: `Estado cambiado a "${status}" por la IA.`, created_by_ai: true });

      return { pqr_id: pqr.id, pqr_code: pqr.code, status };
    }

    case "get_pqr_status": {
      if (!contactId) throw new Error("No hay un contacto vinculado a esta conversación.");

      const { data: pqr, error } = await adminClient
        .from("crm_pqrs")
        .select("id, code, type, subject, status, created_at")
        .eq("tenant_id", tenantId)
        .eq("contact_id", contactId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!pqr) return { found: false };

      const { data: updates } = await adminClient
        .from("crm_pqr_updates")
        .select("id, seq, content, created_at")
        .eq("pqr_id", pqr.id)
        .order("seq", { ascending: false })
        .limit(3);

      // Lets the model know images exist (and their id, to pass to
      // send_attachment) without it ever seeing the pixel content itself.
      const { data: pqrAttachments } = await adminClient.from("crm_attachments").select("id, mime_type").eq("pqr_id", pqr.id);
      const updateIds = (updates ?? []).map((u: { id: string }) => u.id);
      let updateAttachments: { id: string; mime_type: string; pqr_update_id: string }[] = [];
      if (updateIds.length > 0) {
        const { data } = await adminClient.from("crm_attachments").select("id, mime_type, pqr_update_id").in("pqr_update_id", updateIds);
        updateAttachments = data ?? [];
      }

      const recentUpdates = (updates ?? []).map((u: { id: string; seq: number; content: string; created_at: string }) => ({
        seq: u.seq,
        content: u.content,
        created_at: u.created_at,
        attachments: updateAttachments.filter((a) => a.pqr_update_id === u.id).map((a) => ({ id: a.id, mime_type: a.mime_type })),
      }));

      return { found: true, ...pqr, attachments: pqrAttachments ?? [], recent_updates: recentUpdates };
    }

    case "send_attachment": {
      if (!contactId) throw new Error("No hay un contacto vinculado a esta conversación.");
      const attachmentId = String(parameters.attachment_id ?? "").trim();
      if (!attachmentId) throw new Error("attachment_id es requerido");

      const { data: attachment, error: attachmentError } = await adminClient
        .from("crm_attachments")
        .select("id, storage_path, mime_type, pqr_id, pqr_update_id")
        .eq("id", attachmentId)
        .eq("tenant_id", tenantId)
        .maybeSingle();
      if (attachmentError) throw new Error(attachmentError.message);
      if (!attachment) throw new Error("No se encontró ese adjunto.");

      // Only ever send an attachment belonging to the customer's own most
      // recent PQR -- same trust boundary as add_pqr_update/update_pqr_status,
      // prevents a crafted attachment_id from leaking another contact's file.
      const latestPqr = await resolveLatestPqr(adminClient, tenantId, contactId);
      let belongsToLatestPqr = attachment.pqr_id === latestPqr.id;
      if (!belongsToLatestPqr && attachment.pqr_update_id) {
        const { data: updateRow } = await adminClient.from("crm_pqr_updates").select("pqr_id").eq("id", attachment.pqr_update_id).maybeSingle();
        belongsToLatestPqr = updateRow?.pqr_id === latestPqr.id;
      }
      if (!belongsToLatestPqr) throw new Error("Ese adjunto no pertenece al caso más reciente del cliente.");

      const sendContext = await resolveConversationSendContext(adminClient, conversationId);

      const { data: signedUrlData, error: signedUrlError } = await adminClient.storage
        .from("crm-attachments")
        .createSignedUrl(attachment.storage_path, ATTACHMENT_SIGNED_URL_TTL_SECONDS);
      if (signedUrlError || !signedUrlData) throw new Error("No se pudo generar el enlace de la imagen.");

      const sendResult = await sendWhatsappImage(sendContext.phoneNumberId, sendContext.accessToken, sendContext.contactPhone, signedUrlData.signedUrl);
      if (!sendResult.ok) throw new Error(sendResult.errorMessage ?? "No se pudo enviar la imagen.");

      // Leaves a normal trace in the conversation ledger, same as any other
      // outbound message -- the agent sees it in the Inbox like anything
      // else the AI sent, not as a side-channel action invisible to the CRM.
      await adminClient.from("whatsapp_messages").insert({
        conversation_id: conversationId,
        direction: "outbound",
        sender_type: "ia",
        content: "[Imagen enviada]",
        wamid: sendResult.wamid,
        media_storage_path: attachment.storage_path,
        media_mime_type: attachment.mime_type,
      });

      return { sent: true };
    }

    case "book_appointment": {
      if (!contactId) throw new Error("No hay un contacto vinculado a esta conversación.");
      const scheduledAtRaw = String(parameters.scheduled_at ?? "").trim();
      if (!scheduledAtRaw) throw new Error("scheduled_at es requerido");
      const scheduledAt = new Date(scheduledAtRaw);
      if (isNaN(scheduledAt.getTime())) throw new Error("scheduled_at no es una fecha válida.");
      if (scheduledAt.getTime() < Date.now()) throw new Error("La fecha debe ser en el futuro.");
      const notes = parameters.notes ? String(parameters.notes).trim() : null;

      // Same line the conversation is already happening on -- no need to
      // look up "the contact's latest conversation" like the frontend drawer
      // does, we're already inside it.
      const { data: conversation } = await adminClient
        .from("whatsapp_conversations")
        .select("whatsapp_line_id")
        .eq("id", conversationId)
        .maybeSingle();

      const { data, error } = await adminClient
        .from("crm_appointments")
        .insert({
          tenant_id: tenantId,
          contact_id: contactId,
          whatsapp_line_id: conversation?.whatsapp_line_id ?? null,
          scheduled_at: scheduledAt.toISOString(),
          notes,
        })
        .select("id, scheduled_at, status")
        .single();
      if (error) throw new Error(error.message);
      return data;
    }

    case "list_contact_appointments": {
      if (!contactId) throw new Error("No hay un contacto vinculado a esta conversación.");
      const { data, error } = await adminClient
        .from("crm_appointments")
        .select("id, scheduled_at, notes, status")
        .eq("tenant_id", tenantId)
        .eq("contact_id", contactId)
        .eq("status", "activa")
        .gte("scheduled_at", new Date().toISOString())
        .order("scheduled_at", { ascending: true });
      if (error) throw new Error(error.message);
      return { appointments: data ?? [] };
    }

    case "cancel_appointment": {
      if (!contactId) throw new Error("No hay un contacto vinculado a esta conversación.");
      const { data: appt, error } = await adminClient
        .from("crm_appointments")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("contact_id", contactId)
        .eq("status", "activa")
        .order("scheduled_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!appt) throw new Error("Este cliente no tiene ninguna cita activa.");

      const { error: updateError } = await adminClient.from("crm_appointments").update({ status: "cancelada" }).eq("id", appt.id);
      if (updateError) throw new Error(updateError.message);
      return { id: appt.id, status: "cancelada" };
    }

    case "list_pipelines": {
      const { data, error } = await adminClient
        .from("crm_pipelines")
        .select("name, description")
        .eq("tenant_id", tenantId)
        .eq("is_active", true)
        .order("created_at", { ascending: true });
      if (error) throw new Error(error.message);
      return { pipelines: data ?? [] };
    }

    case "create_opportunity": {
      if (!contactId) throw new Error("No hay un contacto vinculado a esta conversación.");
      const pipelineName = String(parameters.pipeline_name ?? "").trim();
      if (!pipelineName) throw new Error("pipeline_name es requerido");
      const title = String(parameters.title ?? "").trim();
      if (!title) throw new Error("title es requerido");
      const priority = parameters.priority ? String(parameters.priority) : "media";
      if (!OPPORTUNITY_PRIORITIES.includes(priority)) throw new Error(`priority inválida: ${priority}`);

      const { pipelineId, stageId } = await resolvePipelineAndFirstStage(adminClient, tenantId, pipelineName);

      // Idempotent by (contact, pipeline) instead of trusting the model to
      // remember "ya creé una para este cliente" across turns -- a stateless
      // per-turn LLM can't reliably track that itself (same reasoning as
      // resolveOrCreateOpportunityForQuote below). Reopening this tool call
      // on an existing open deal UPDATES it to the new call's title/value/
      // description instead of silently returning the stale one -- a
      // contact's open deal in a pipeline is treated as one rolling "what
      // they're currently interested in", not left describing whatever they
      // asked about first. Simpler than trying to detect "is this genuinely
      // a different product/deal" from free-text titles, and it's what
      // actually matched the real bug: a customer who asked about camisetas
      // earlier, then later asked about botas, kept showing "Interesado en
      // camisetas" in the pipeline forever.
      const { data: existing } = await adminClient
        .from("crm_opportunities")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("contact_id", contactId)
        .eq("pipeline_id", pipelineId)
        .eq("status", "open")
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (existing) {
        const { data: updated, error: updateError } = await adminClient
          .from("crm_opportunities")
          .update({
            title,
            value: typeof parameters.value === "number" ? parameters.value : 0,
            priority,
            expected_close_date: parameters.expected_close_date ? String(parameters.expected_close_date) : null,
            description: parameters.description ? String(parameters.description).trim() : null,
          })
          .eq("id", existing.id)
          .select("id, title")
          .single();
        if (updateError) throw new Error(updateError.message);
        return updated;
      }

      const { data, error } = await adminClient
        .from("crm_opportunities")
        .insert({
          tenant_id: tenantId,
          pipeline_id: pipelineId,
          stage_id: stageId,
          contact_id: contactId,
          title,
          value: typeof parameters.value === "number" ? parameters.value : 0,
          priority,
          expected_close_date: parameters.expected_close_date ? String(parameters.expected_close_date) : null,
          description: parameters.description ? String(parameters.description).trim() : null,
          source: "whatsapp_ia",
        })
        .select("id, title")
        .single();
      if (error) throw new Error(error.message);
      return data;
    }

    case "update_opportunity_stage": {
      const opportunity = await resolveLatestOpenOpportunity(adminClient, tenantId, contactId);
      const stageName = String(parameters.stage_name ?? "").trim();
      if (!stageName) throw new Error("stage_name es requerido");

      const { data: stages, error: stagesError } = await adminClient
        .from("crm_pipeline_stages")
        .select("id, name, is_won, is_lost")
        .eq("pipeline_id", opportunity.pipeline_id);
      if (stagesError) throw new Error(stagesError.message);

      const stage = (stages ?? []).find((s: { name: string }) => s.name.toLowerCase() === stageName.toLowerCase());
      if (!stage) {
        const validNames = (stages ?? []).map((s: { name: string }) => s.name).join(", ");
        throw new Error(`Etapa "${stageName}" no existe en este pipeline. Etapas válidas: ${validNames}`);
      }

      const status = stage.is_won ? "won" : stage.is_lost ? "lost" : "open";
      const { error: updateError } = await adminClient.from("crm_opportunities").update({ stage_id: stage.id, status }).eq("id", opportunity.id);
      if (updateError) throw new Error(updateError.message);
      return { id: opportunity.id, stage: stage.name, status };
    }

    case "get_opportunity_status": {
      if (!contactId) throw new Error("No hay un contacto vinculado a esta conversación.");
      const { data: opportunity, error } = await adminClient
        .from("crm_opportunities")
        .select("id, title, value, currency, status, stage_id")
        .eq("tenant_id", tenantId)
        .eq("contact_id", contactId)
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!opportunity) return { found: false };

      const { data: stage } = await adminClient.from("crm_pipeline_stages").select("name").eq("id", opportunity.stage_id).maybeSingle();
      return {
        found: true,
        title: opportunity.title,
        value: opportunity.value,
        currency: opportunity.currency,
        status: opportunity.status,
        stage: stage?.name ?? null,
      };
    }

    case "flag_interest_for_followup": {
      if (!contactId) throw new Error("No hay un contacto vinculado a esta conversación.");
      const productName = String(parameters.product_name ?? "").trim();
      if (!productName) throw new Error("product_name es requerido");
      const note = parameters.note ? String(parameters.note).trim() : null;

      const { data: opportunity } = await adminClient
        .from("crm_opportunities")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("contact_id", contactId)
        .eq("status", "open")
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      const { data: contact } = await adminClient.from("crm_contacts").select("assigned_to").eq("id", contactId).maybeSingle();

      const { error } = await adminClient.from("crm_tasks").insert({
        tenant_id: tenantId,
        contact_id: contactId,
        opportunity_id: opportunity?.id ?? null,
        assigned_to: contact?.assigned_to ?? null,
        title: `Seguimiento: interés en ${productName}`,
        description: note,
        priority: "media",
        due_date: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      });
      if (error) throw new Error(error.message);

      return { flagged: true, product: productName };
    }

    case "set_lead_stage": {
      if (!contactId) throw new Error("No hay un contacto vinculado a esta conversación.");
      const stage = String(parameters.stage ?? "");
      if (!LEAD_STAGES.includes(stage)) throw new Error(`stage inválido: ${stage}`);

      const { error } = await adminClient.from("crm_contacts").update({ stage }).eq("id", contactId);
      if (error) throw new Error(error.message);
      return { contact_id: contactId, stage };
    }

    case "list_catalog_categories": {
      // Hard-capped at CATEGORY_LIST_LIMIT server-side (not left to the
      // model to "remember to only show 5") -- a tenant that wants its
      // greeting to lead with categories needs this to be reliable, not a
      // prompt suggestion the model might ignore on a long category list.
      const { data, error } = await adminClient
        .from("crm_product_categories")
        .select("name, description")
        .eq("tenant_id", tenantId)
        .is("deleted_at", null)
        .order("name", { ascending: true })
        .limit(CATEGORY_LIST_LIMIT);
      if (error) throw new Error(error.message);
      return { categories: data ?? [] };
    }

    case "list_catalog_products": {
      // Deliberately doesn't select/return stock at all -- browsing the
      // catalog should never surface quantities or "agotado" to the
      // customer (a tenant preference, see the catalogo skill's
      // prompt_fragment). Data minimization instead of a prompt-only rule:
      // if the model never receives the number, it can't leak it here no
      // matter how it's instructed. create_quote is the one place stock is
      // still checked and disclosed -- reactively, only once the customer
      // is actually trying to buy a specific quantity.
      const search = parameters.search ? String(parameters.search).trim() : "";
      const category = parameters.category ? String(parameters.category).trim() : "";

      // Category browsing (no search term) is a distinct case: pulls stock
      // internally to rank by it (most-stocked first -- a reasonable proxy
      // for "what to lead with" when a tenant wants a proactive salesperson
      // tone), then strips it back out of what actually gets returned. The
      // model never sees the numbers, only the resulting order.
      if (category && !search) {
        // !inner is required here -- without it, .eq() on the embedded
        // resource doesn't restrict the base crm_products rows at all (it's
        // a left join), so non-matching products still come back with
        // category: null instead of being excluded. Found 2026-08-10: a
        // "Posgrado" query returned every Pregrado product too.
        const { data, error } = await adminClient
          .from("crm_products")
          .select("name, sku, retail_price, description, track_inventory, stock_quantity, reserved_stock, category:crm_product_categories!inner(name)")
          .eq("tenant_id", tenantId)
          .eq("is_active", true)
          .is("deleted_at", null)
          .eq("crm_product_categories.name", category);
        if (error) throw new Error(error.message);

        const ranked = (data ?? [])
          .map((p: any) => ({
            name: p.name,
            sku: p.sku,
            price: formatCurrencyCOP(p.retail_price),
            category: p.category?.name ?? null,
            description: p.description ?? null,
            _rank: p.track_inventory ? p.stock_quantity - p.reserved_stock : Number.POSITIVE_INFINITY,
          }))
          .sort((a: any, b: any) => b._rank - a._rank)
          .slice(0, CATEGORY_TOP_PRODUCTS_LIMIT)
          .map(({ _rank, ...rest }: any) => rest);

        return { products: ranked };
      }

      // !inner on the embed is required whenever a category filter is
      // present -- see the comment above for why a plain embed doesn't
      // actually restrict rows.
      const categorySelect = category
        ? "name, sku, retail_price, description, category:crm_product_categories!inner(name)"
        : "name, sku, retail_price, description, category:crm_product_categories(name)";

      let query = adminClient
        .from("crm_products")
        .select(categorySelect)
        .eq("tenant_id", tenantId)
        .eq("is_active", true)
        .is("deleted_at", null)
        .order("name", { ascending: true })
        .limit(CATALOG_SEARCH_LIMIT);

      // Full-text search (Spanish config), not a rigid ILIKE substring --
      // an ILIKE '%camiseta de algodón%' never matches "Camiseta Algodón
      // Premium" (word order/extra words), and '%camisetas%' never matches
      // singular "Camiseta" either. to_tsvector/plainto_tsquery handles
      // plurals, word order and accents correctly instead.
      if (search) query = query.textSearch("name", search, { type: "plain", config: "spanish" });
      if (category) query = query.eq("crm_product_categories.name", category);

      let { data, error } = await query;
      if (error) throw new Error(error.message);
      // Fallback for queries textSearch can legitimately miss (a bare SKU,
      // a single short word) -- only runs when the primary search found
      // nothing, so it never changes behavior for a query that already works.
      if (search && (!data || data.length === 0)) {
        let fallbackQuery = adminClient
          .from("crm_products")
          .select(categorySelect)
          .eq("tenant_id", tenantId)
          .eq("is_active", true)
          .is("deleted_at", null)
          .ilike("name", `%${search}%`)
          .order("name", { ascending: true })
          .limit(CATALOG_SEARCH_LIMIT);
        if (category) fallbackQuery = fallbackQuery.eq("crm_product_categories.name", category);
        const fallback = await fallbackQuery;
        if (fallback.error) throw new Error(fallback.error.message);
        data = fallback.data;
      }

      const products = (data ?? []).map((p: any) => ({
        name: p.name,
        sku: p.sku,
        price: formatCurrencyCOP(p.retail_price),
        category: p.category?.name ?? null,
        description: p.description ?? null,
      }));
      return { products };
    }

    case "send_product_image": {
      const productName = String(parameters.product_name ?? "").trim();
      if (!productName) throw new Error("product_name es requerido");

      const product = await findProductByName(adminClient, tenantId, productName);
      if (!product) throw new Error(`No se encontró el producto "${productName}" en el catálogo.`);

      const { data: image, error: imageError } = await adminClient
        .from("crm_product_images")
        .select("storage_path")
        .eq("product_id", product.id)
        .order("display_order", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (imageError) throw new Error(imageError.message);
      if (!image) throw new Error(`El producto "${product.name}" todavía no tiene ninguna foto cargada.`);

      // product-images is a public bucket (unlike crm-attachments) -- no
      // signed URL needed, Meta can fetch the public URL directly.
      const { data: publicUrlData } = adminClient.storage.from("product-images").getPublicUrl(image.storage_path);

      const sendContext = await resolveConversationSendContext(adminClient, conversationId);
      const sendResult = await sendWhatsappImage(sendContext.phoneNumberId, sendContext.accessToken, sendContext.contactPhone, publicUrlData.publicUrl);
      if (!sendResult.ok) throw new Error(sendResult.errorMessage ?? "No se pudo enviar la imagen.");

      await adminClient.from("whatsapp_messages").insert({
        conversation_id: conversationId,
        direction: "outbound",
        sender_type: "ia",
        content: "[Imagen enviada]",
        wamid: sendResult.wamid,
      });

      return { sent: true, product: product.name };
    }

    case "create_quote": {
      if (!contactId) throw new Error("No hay un contacto vinculado a esta conversación.");
      const rawItems = Array.isArray(parameters.items) ? parameters.items : [];
      if (rawItems.length === 0) throw new Error("items es requerido y no puede estar vacío.");

      const resolvedItems: { product_id: string; product_name: string; sku: string | null; quantity: number; unit_price: number }[] = [];
      for (const rawItem of rawItems) {
        const productName = String((rawItem as Record<string, unknown>).product_name ?? "").trim();
        const quantity = Number((rawItem as Record<string, unknown>).quantity);
        if (!productName) throw new Error("Cada línea necesita product_name.");
        if (!Number.isFinite(quantity) || quantity <= 0) throw new Error(`Cantidad inválida para "${productName}".`);

        const product = await findProductByName(adminClient, tenantId, productName);
        if (!product) throw new Error(`No se encontró el producto "${productName}" en el catálogo.`);

        // Deliberately no stock check here (removed 2026-08-10, real-world
        // test feedback): a cotización is a price estimate, not a stock
        // commitment -- rejecting/capping it when requested quantity exceeds
        // current inventory also meant this whole function threw before ever
        // reaching resolveOrCreateOpportunityForQuote below, so a customer
        // asking for more than what's in stock silently never got an
        // opportunity created either. Availability is still a real business
        // question, just not one the AI should gate quote creation on --
        // fulfillment/backorder is a human call. reserved_stock still
        // accumulates normally via the crm_order_items trigger even past
        // physical stock_quantity; nothing here blocks that.
        resolvedItems.push({
          product_id: product.id,
          product_name: product.name,
          sku: product.sku,
          quantity,
          unit_price: product.retail_price ?? 0,
        });
      }

      const subtotal = resolvedItems.reduce((sum, item) => sum + item.quantity * item.unit_price, 0);
      const notes = parameters.notes ? String(parameters.notes).trim() : null;

      // Auto-links to the pipeline so a WhatsApp sale shows up there without
      // anyone loading it by hand: reuse the contact's open opportunity if
      // it has one, otherwise create one (see resolveOrCreateOpportunityForQuote).
      const opportunityId = await resolveOrCreateOpportunityForQuote(adminClient, tenantId, contactId, subtotal);

      const { data: order, error: orderError } = await adminClient
        .from("crm_orders")
        .insert({ tenant_id: tenantId, contact_id: contactId, opportunity_id: opportunityId, notes, subtotal, total: subtotal })
        .select("id, number")
        .single();
      if (orderError) throw new Error(orderError.message);

      const itemRows = resolvedItems.map((item, index) => ({
        tenant_id: tenantId,
        order_id: order.id,
        product_id: item.product_id,
        product_name: item.product_name,
        sku: item.sku,
        quantity: item.quantity,
        unit_price: item.unit_price,
        subtotal: item.quantity * item.unit_price,
        display_order: index,
      }));
      const { error: itemsError } = await adminClient.from("crm_order_items").insert(itemRows);
      if (itemsError) throw new Error(itemsError.message);

      return {
        order_number: order.number,
        order_code: formatOrderCode(order.number),
        total: formatCurrencyCOP(subtotal),
        items: resolvedItems.map((i) => ({
          product: i.product_name,
          quantity: i.quantity,
          unit_price: formatCurrencyCOP(i.unit_price),
          subtotal: formatCurrencyCOP(i.quantity * i.unit_price),
        })),
      };
    }

    case "get_quote_status": {
      const order = await resolveLatestOrder(adminClient, tenantId, contactId);
      if (!order) return { found: false };

      const { data: items } = await adminClient
        .from("crm_order_items")
        .select("product_name, quantity, unit_price, subtotal")
        .eq("order_id", order.id)
        .order("display_order", { ascending: true });

      const { data: payments } = await adminClient.from("crm_order_payments").select("amount").eq("order_id", order.id).is("deleted_at", null);
      const totalPaid = (payments ?? []).reduce((sum: number, p: { amount: number }) => sum + p.amount, 0);
      const balanceDue = Math.max(0, order.total - totalPaid);

      return {
        found: true,
        order_number: order.number,
        order_code: formatOrderCode(order.number),
        status: order.status,
        total: formatCurrencyCOP(order.total),
        total_paid: formatCurrencyCOP(totalPaid),
        balance_due: formatCurrencyCOP(balanceDue),
        notes: order.notes,
        items: (items ?? []).map((item: { product_name: string; quantity: number; unit_price: number; subtotal: number }) => ({
          product_name: item.product_name,
          quantity: item.quantity,
          unit_price: formatCurrencyCOP(item.unit_price),
          subtotal: formatCurrencyCOP(item.subtotal),
        })),
      };
    }

    case "add_order_comment": {
      const order = await resolveLatestOrder(adminClient, tenantId, contactId);
      if (!order) throw new Error("Este cliente no tiene ninguna cotización ni venta todavía.");
      const comment = String(parameters.comment ?? "").trim();
      if (!comment) throw new Error("comment es requerido");

      const { error } = await adminClient
        .from("crm_order_comments")
        .insert({ tenant_id: tenantId, order_id: order.id, content: comment, created_by_ai: true });
      if (error) throw new Error(error.message);

      return { order_number: order.number, order_code: formatOrderCode(order.number), commented: true };
    }

    case "confirm_quote": {
      const order = await resolveLatestOrder(adminClient, tenantId, contactId, "cotizacion");
      if (!order) throw new Error("Este cliente no tiene ninguna cotización pendiente de confirmar.");

      // This is where stock actually gets checked, not at create_quote --
      // a cotización is just a price estimate (see create_quote), but
      // confirming it is the real commitment that turns a reservation into
      // an actual inventory deduction (the status-change trigger in
      // 20260809000001_order_stock_effects.sql), so it's the one place that
      // has to know fulfillment is possible before it happens.
      const { data: items } = await adminClient
        .from("crm_order_items")
        .select("product_name, quantity, product_id")
        .eq("order_id", order.id)
        .not("product_id", "is", null);
      for (const item of items ?? []) {
        const { data: product } = await adminClient
          .from("crm_products")
          .select("track_inventory, stock_quantity, reserved_stock")
          .eq("id", item.product_id)
          .maybeSingle();
        if (!product?.track_inventory) continue;
        const available = product.stock_quantity - product.reserved_stock + item.quantity; // this item's own reservation still counts as "held for it"
        if (available < item.quantity) {
          throw new Error(`Stock insuficiente para confirmar "${item.product_name}": disponible ${Math.max(0, available)}, pedido ${item.quantity}.`);
        }
      }

      // Moving the linked opportunity (if any) to its pipeline's "Ganado"
      // stage now happens in a DB trigger (trg_crm_orders_confirmed_opportunity,
      // 20260809170000) so it also covers a human agent confirming the sale
      // by hand from Ventas.tsx, not just this AI path -- nothing to do here.
      const { error } = await adminClient.from("crm_orders").update({ status: "confirmada" }).eq("id", order.id);
      if (error) throw new Error(error.message);

      return { order_number: order.number, order_code: formatOrderCode(order.number), status: "confirmada" };
    }

    case "cancel_quote": {
      const order = await resolveLatestOrder(adminClient, tenantId, contactId, "cotizacion");
      if (!order) throw new Error("Este cliente no tiene ninguna cotización pendiente de cancelar.");

      const { error } = await adminClient.from("crm_orders").update({ status: "cancelada" }).eq("id", order.id);
      if (error) throw new Error(error.message);
      return { order_number: order.number, order_code: formatOrderCode(order.number), status: "cancelada" };
    }

    case "complete_sale": {
      if (!contactId) throw new Error("No hay un contacto vinculado a esta conversación.");
      // Not resolveLatestOrder(status=X) -- this needs to match either of two
      // statuses (confirmada or en_proceso), which that helper's single-value
      // filter can't express, so it queries directly instead.
      const { data: order, error: orderError } = await adminClient
        .from("crm_orders")
        .select("id, number")
        .eq("tenant_id", tenantId)
        .eq("contact_id", contactId)
        .in("status", ["confirmada", "en_proceso"])
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (orderError) throw new Error(orderError.message);
      if (!order) throw new Error("Este cliente no tiene ninguna venta confirmada pendiente de completar.");

      const { error } = await adminClient.from("crm_orders").update({ status: "entregada" }).eq("id", order.id);
      if (error) throw new Error(error.message);
      return { order_number: order.number, order_code: formatOrderCode(order.number), status: "entregada" };
    }

    case "list_contact_addresses": {
      if (!contactId) throw new Error("No hay un contacto vinculado a esta conversación.");
      const { data, error } = await adminClient
        .from("crm_contact_addresses")
        .select("id, label, is_shipping, is_billing, is_default, line1, line2, city, state_province, postal_code, country")
        .eq("tenant_id", tenantId)
        .eq("contact_id", contactId)
        .is("deleted_at", null)
        .order("is_default", { ascending: false })
        .order("created_at", { ascending: false });
      if (error) throw new Error(error.message);
      return { addresses: data ?? [] };
    }

    case "save_contact_address": {
      if (!contactId) throw new Error("No hay un contacto vinculado a esta conversación.");

      // Only overwrites the fields the model actually sent -- lets "usá la
      // misma de siempre, aplicala a esta venta" be a single call
      // (address_id + apply_as_* only) without touching the rest of an
      // already-saved address.
      const fields: Record<string, unknown> = {};
      const stringFields = ["label", "recipient_name", "phone", "tax_id", "line1", "line2", "city", "state_province", "postal_code", "country", "notes"];
      for (const key of stringFields) {
        if (parameters[key] !== undefined) fields[key] = String(parameters[key]).trim() || null;
      }
      if (typeof parameters.is_shipping === "boolean") fields.is_shipping = parameters.is_shipping;
      if (typeof parameters.is_billing === "boolean") fields.is_billing = parameters.is_billing;

      const addressId = parameters.address_id ? String(parameters.address_id) : null;
      let savedAddressId = addressId;

      if (addressId) {
        const { error } = await adminClient
          .from("crm_contact_addresses")
          .update(fields)
          .eq("id", addressId)
          .eq("tenant_id", tenantId)
          .eq("contact_id", contactId);
        if (error) throw new Error(error.message);
      } else {
        if (!fields.line1) throw new Error("line1 es requerido para guardar una dirección nueva.");
        const { data: inserted, error } = await adminClient
          .from("crm_contact_addresses")
          .insert({ tenant_id: tenantId, contact_id: contactId, is_shipping: true, ...fields, is_default: true })
          .select("id")
          .single();
        if (error) throw new Error(error.message);
        savedAddressId = inserted.id;
      }

      const applyAsShipping = parameters.apply_as_shipping === true;
      const applyAsBilling = parameters.apply_as_billing === true;
      if ((applyAsShipping || applyAsBilling) && savedAddressId) {
        const order = await resolveLatestOrder(adminClient, tenantId, contactId);
        if (order) {
          const orderUpdate: Record<string, string> = {};
          if (applyAsShipping) orderUpdate.shipping_address_id = savedAddressId;
          if (applyAsBilling) orderUpdate.billing_address_id = savedAddressId;
          await adminClient.from("crm_orders").update(orderUpdate).eq("id", order.id);
        }
      }

      return { address_id: savedAddressId, saved: true };
    }

    default:
      throw new Error(`Unknown function_name: ${functionName}`);
  }
}

/** If whatsapp-ai-respond injected a pending_attachment (a photo the customer
 * just sent, already downloaded and uploaded to the crm-attachments bucket
 * by whatsapp-webhook), links it to the PQR/update this call just created --
 * no file is copied, this just reuses the storage_path already uploaded.
 * Never throws: a bad/missing attachment shouldn't fail the PQR/update
 * creation itself, it just means the photo doesn't show up this time. */
// deno-lint-ignore no-explicit-any
async function linkPendingAttachment(
  // deno-lint-ignore no-explicit-any
  adminClient: any,
  tenantId: string,
  parentColumn: "pqr_id" | "pqr_update_id",
  parentId: string,
  parameters: Record<string, unknown>,
) {
  const pending = parameters.pending_attachment as { storage_path?: string; mime_type?: string; size_bytes?: number } | undefined;
  if (!pending?.storage_path || !pending.mime_type) return;

  const { error } = await adminClient.from("crm_attachments").insert({
    tenant_id: tenantId,
    [parentColumn]: parentId,
    storage_path: pending.storage_path,
    mime_type: pending.mime_type,
    size_bytes: pending.size_bytes ?? 0,
    created_by_ai: true,
  });
  if (error) console.error(`Failed to link pending attachment to ${parentColumn}=${parentId}`, error);
}

/** Resolves "the customer's most recent PQR" -- used by every tool that acts
 * on an existing case without the model having to (unreliably) remember an
 * id across turns. Returns the human-readable `code` alongside the id so
 * callers can relay it back to the customer. */
// deno-lint-ignore no-explicit-any
async function resolveLatestPqr(adminClient: any, tenantId: string, contactId: string | undefined): Promise<{ id: string; code: number }> {
  if (!contactId) throw new Error("No hay un contacto vinculado a esta conversación.");

  const { data, error } = await adminClient
    .from("crm_pqrs")
    .select("id, code")
    .eq("tenant_id", tenantId)
    .eq("contact_id", contactId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Este cliente todavía no tiene ningún PQR registrado.");
  return data;
}

/** Resolves a tenant's pipeline by name (case-insensitive, as returned by
 * list_pipelines) plus its lowest-display_order stage -- lets
 * create_opportunity land a new case in whichever pipeline actually fits
 * the customer's need (Ventas, Soporte y Postventa, Onboarding, ...)
 * instead of always defaulting to one fixed pipeline. Every tenant is
 * guaranteed at least the seeded "Ventas" pipeline (seed_default_pipeline
 * trigger fires on tenant creation), so this never has to special-case "no
 * pipeline yet" -- only "no pipeline named that". */
// deno-lint-ignore no-explicit-any
async function resolvePipelineAndFirstStage(
  adminClient: any,
  tenantId: string,
  pipelineName: string,
): Promise<{ pipelineId: string; stageId: string; stageName: string }> {
  const { data: pipelines, error } = await adminClient
    .from("crm_pipelines")
    .select("id, name")
    .eq("tenant_id", tenantId)
    .eq("is_active", true);
  if (error) throw new Error(error.message);
  if (!pipelines || pipelines.length === 0) throw new Error("Este tenant no tiene ningún pipeline configurado.");

  // Falls back to the tenant's one pipeline instead of erroring when there's
  // no ambiguity to resolve -- most tenants only ever have the seeded
  // "Ventas" pipeline, and a model that guesses a plausible-sounding name
  // (e.g. "Admisiones" for a university tenant) would otherwise silently
  // fail to create the opportunity while still telling the customer it was
  // registered (found 2026-08-10). Only tenants with more than one pipeline
  // still need the model to get the name right.
  let pipeline = pipelines.find((p: { name: string }) => p.name.toLowerCase() === pipelineName.toLowerCase());
  if (!pipeline && pipelines.length === 1) pipeline = pipelines[0];
  if (!pipeline) {
    const validNames = pipelines.map((p: { name: string }) => p.name).join(", ");
    throw new Error(`Pipeline "${pipelineName}" no existe. Pipelines válidos: ${validNames}`);
  }

  const { data: stage, error: stageError } = await adminClient
    .from("crm_pipeline_stages")
    .select("id, name")
    .eq("pipeline_id", pipeline.id)
    .order("display_order", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (stageError) throw new Error(stageError.message);
  if (!stage) throw new Error(`El pipeline "${pipeline.name}" no tiene etapas configuradas.`);

  return { pipelineId: pipeline.id, stageId: stage.id, stageName: stage.name };
}

/** Same "most recent X of the contact" pattern as resolveLatestPqr, over
 * crm_opportunities -- lets update_opportunity_stage/get_opportunity_status
 * act without the model having to remember an id across turns. */
// deno-lint-ignore no-explicit-any
async function resolveLatestOpenOpportunity(
  // deno-lint-ignore no-explicit-any
  adminClient: any,
  tenantId: string,
  contactId: string | undefined,
): Promise<{ id: string; pipeline_id: string; stage_id: string; title: string }> {
  if (!contactId) throw new Error("No hay un contacto vinculado a esta conversación.");

  const { data, error } = await adminClient
    .from("crm_opportunities")
    .select("id, pipeline_id, stage_id, title")
    .eq("tenant_id", tenantId)
    .eq("contact_id", contactId)
    .eq("status", "open")
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Este cliente todavía no tiene ninguna oportunidad abierta.");
  return data;
}

/** Shared by send_attachment and send_product_image -- both need the same
 * three things to call the Graph API: the line's phone_number_id, its
 * decrypted access token, and the customer's phone. */
// deno-lint-ignore no-explicit-any
async function resolveConversationSendContext(
  // deno-lint-ignore no-explicit-any
  adminClient: any,
  conversationId: string,
): Promise<{ phoneNumberId: string; accessToken: string; contactPhone: string }> {
  const { data: conversation, error: convError } = await adminClient
    .from("whatsapp_conversations")
    .select("contact_phone, whatsapp_line_id")
    .eq("id", conversationId)
    .single();
  if (convError || !conversation) throw new Error("No se encontró la conversación.");

  const { data: line, error: lineError } = await adminClient
    .from("whatsapp_lines")
    .select("phone_number_id")
    .eq("id", conversation.whatsapp_line_id)
    .single();
  if (lineError || !line) throw new Error("No se encontró la línea de WhatsApp.");

  const { data: accessToken } = await adminClient.rpc("get_whatsapp_line_access_token", { p_line_id: conversation.whatsapp_line_id });
  if (!accessToken) throw new Error("Esta línea no tiene un token de acceso configurado.");

  return { phoneNumberId: line.phone_number_id, accessToken, contactPhone: conversation.contact_phone };
}

/** Resolves "the customer's most recent order" (cotización or venta -- same
 * entity, see 20260808000003_crm_orders.sql), optionally narrowed to a
 * specific status (e.g. confirm_quote/cancel_quote only ever act on one
 * still in "cotizacion", never on an already-confirmed venta). */
// deno-lint-ignore no-explicit-any
async function resolveLatestOrder(
  // deno-lint-ignore no-explicit-any
  adminClient: any,
  tenantId: string,
  contactId: string | undefined,
  status?: string,
): Promise<{ id: string; number: number; status: string; total: number; currency: string; notes: string | null } | null> {
  if (!contactId) throw new Error("No hay un contacto vinculado a esta conversación.");

  let query = adminClient
    .from("crm_orders")
    .select("id, number, status, total, currency, notes")
    .eq("tenant_id", tenantId)
    .eq("contact_id", contactId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(1);
  if (status) query = query.eq("status", status);

  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

/** "1" -> "001" -- the human-facing code the model should quote back to the
 * customer ("tu cotización 001"), computed here instead of left to the
 * model to pad itself. */
function formatOrderCode(number: number): string {
  return String(number).padStart(3, "0");
}

/** "219900" -> "$219.900" -- same reasoning as formatOrderCode: a real-world
 * test (2026-08-10) showed the model echoing raw numbers verbatim in its
 * quote list ("219900", "109950000") because the prompt tells it to use
 * price/quantity "tal cual te los devuelve la herramienta" -- formatting
 * money is a deterministic, mechanical step that shouldn't depend on the
 * model doing it correctly (or at all) every time. Every price/subtotal/
 * total create_quote and get_quote_status return is pre-formatted here;
 * the model only ever has to print the string it's given. Colombian peso
 * only, no decimals -- matches every currency formatter already in
 * leadly-app's own frontend (Intl.NumberFormat('es-CO', ...)). */
function formatCurrencyCOP(value: number): string {
  return new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(value);
}

/** Keeps the pipeline in sync with sales activity that happens entirely
 * over WhatsApp, with no agent loading it into the CRM by hand: reuses the
 * contact's existing open opportunity if it has one (so a customer who's
 * already "Interesado en Audífonos" via create_opportunity doesn't get a
 * second, duplicate card once they actually quote it), otherwise creates
 * one in the tenant's default sales pipeline. Returns null (never throws)
 * on any setup problem -- a tenant with e.g. no pipeline stages configured
 * shouldn't be unable to create a quote just because the pipeline side
 * failed; the quote itself is the important part. */
// deno-lint-ignore no-explicit-any
async function resolveOrCreateOpportunityForQuote(
  // deno-lint-ignore no-explicit-any
  adminClient: any,
  tenantId: string,
  contactId: string,
  quoteTotal: number,
): Promise<string | null> {
  try {
    const { data: existing } = await adminClient
      .from("crm_opportunities")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("contact_id", contactId)
      .eq("status", "open")
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existing) return existing.id;

    const { data: pipelines } = await adminClient
      .from("crm_pipelines")
      .select("id, name")
      .eq("tenant_id", tenantId)
      .eq("is_active", true);
    if (!pipelines || pipelines.length === 0) return null;
    const pipeline = pipelines.find((p: { name: string }) => p.name.toLowerCase() === "ventas") ?? pipelines[0];

    // A cotización is already a formal proposal, not a fresh lead -- lands
    // on the "Propuesta" stage if the pipeline has one (the default seeded
    // pipeline always does), falling back to the first stage otherwise.
    const { data: stages } = await adminClient
      .from("crm_pipeline_stages")
      .select("id, name, display_order")
      .eq("pipeline_id", pipeline.id)
      .order("display_order", { ascending: true });
    if (!stages || stages.length === 0) return null;
    const stage = stages.find((s: { name: string }) => s.name.toLowerCase() === "propuesta") ?? stages[0];

    const { data: opportunity, error } = await adminClient
      .from("crm_opportunities")
      .insert({
        tenant_id: tenantId,
        pipeline_id: pipeline.id,
        stage_id: stage.id,
        contact_id: contactId,
        title: "Cotización por WhatsApp",
        value: quoteTotal,
        source: "whatsapp_ia",
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return opportunity.id;
  } catch (err) {
    console.error("resolveOrCreateOpportunityForQuote failed", err);
    return null;
  }
}

/** Shared by send_product_image and create_quote -- resolves a single
 * product by the name the model gives it. Two passes: an exact
 * (case-insensitive) match first, since the model is instructed to echo
 * back the precise name list_catalog_products returned; a full-text-search
 * fallback second, for when it paraphrases slightly (plural, reordered
 * words, missing an accent). Never throws -- returns null so the caller can
 * give its own "no encontrado" message with the right product_name in it. */
// deno-lint-ignore no-explicit-any
async function findProductByName(adminClient: any, tenantId: string, name: string): Promise<Record<string, unknown> | null> {
  const columns = "id, name, sku, retail_price, track_inventory, stock_quantity, reserved_stock";

  const { data: exact } = await adminClient
    .from("crm_products")
    .select(columns)
    .eq("tenant_id", tenantId)
    .eq("is_active", true)
    .is("deleted_at", null)
    .ilike("name", name)
    .maybeSingle();
  if (exact) return exact;

  const { data: fuzzy } = await adminClient
    .from("crm_products")
    .select(columns)
    .eq("tenant_id", tenantId)
    .eq("is_active", true)
    .is("deleted_at", null)
    .textSearch("name", name, { type: "plain", config: "spanish" })
    .limit(1);
  return fuzzy && fuzzy.length > 0 ? fuzzy[0] : null;
}
