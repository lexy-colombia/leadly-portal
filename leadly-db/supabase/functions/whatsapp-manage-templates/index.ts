// Creates, syncs and (soft-)deletes WhatsApp message templates (HSM) against
// a tenant's own WABA -- see CLAUDE.md, Fase 1 de "iniciar conversaciones".
// One function with an `action` dispatcher, same shape as a single coherent
// flow (mirrors whatsapp-embedded-signup, which also does several sequential
// Graph API calls in one function) instead of three functions duplicating
// the "resolve caller's tenant + their WABA" boilerplate three times.
//
// Runs entirely with the caller's own JWT -- no service_role needed, RLS on
// whatsapp_message_templates already scopes reads/writes to the caller's
// tenant (or superadmin), same as whatsapp-send-human.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, json } from "../_shared/cors.ts";

const GRAPH_API_VERSION = "v21.0";
const TEMPLATE_CATEGORIES = ["MARKETING", "UTILITY", "AUTHENTICATION"];

interface RequestBody {
  action?: "create" | "edit" | "sync_status" | "delete";
  tenant_id?: string;
  name?: string;
  category?: string;
  language?: string;
  body_text?: string;
  body_variable_samples?: string[];
  template_id?: string;
}

/** Meta only accepts lowercase letters, digits and underscores. Normalizing
 * instead of rejecting: the tenant types a human name ("Recordatorio de
 * cita"), we turn it into something Meta will actually accept. */
function normalizeTemplateName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip accents
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Counts the positional {{n}} variables in a template body and validates
 * they're sequential starting at 1 (Meta requires this) -- returns null if
 * the body has no variables (valid, variable_count 0) or throws a message if
 * the numbering is inconsistent (e.g. {{1}} and {{3}} but no {{2}}). */
function countVariables(bodyText: string): { count: number } | { error: string } {
  const matches = [...bodyText.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
  if (matches.length === 0) return { count: 0 };
  const max = Math.max(...matches);
  const distinct = new Set(matches);
  for (let n = 1; n <= max; n++) {
    if (!distinct.has(n)) return { error: `Falta la variable {{${n}}} -- las variables deben ser consecutivas empezando en {{1}}.` };
  }
  return { count: max };
}

/** Shared by "create" and "edit": validates the body + its variable samples
 * and builds the Graph API BODY component. Meta auto-rejects any template
 * with variables that has no sample text per variable ("Variables de
 * plantilla sin texto de muestra") -- samples are review-only, never sent to
 * customers. */
function buildBodyComponent(bodyText: string, samples: string[] | undefined): { component: Record<string, unknown>; count: number } | { error: string } {
  const variables = countVariables(bodyText);
  if ("error" in variables) return { error: variables.error };
  const provided = samples ?? [];
  if (variables.count > 0 && (provided.length !== variables.count || provided.some((s) => !s?.trim()))) {
    return { error: `Falta el texto de muestra de alguna variable -- se necesitan ${variables.count}.` };
  }
  const component: Record<string, unknown> = { type: "BODY", text: bodyText.trim() };
  if (variables.count > 0) {
    component.example = { body_text: [provided.map((s) => s.trim())] };
  }
  return { component, count: variables.count };
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
  const { action, tenant_id: tenantId } = body;
  if (!action || !tenantId) {
    return json({ error: "action and tenant_id are required" }, 400);
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

  if (action === "delete") {
    const { template_id } = body;
    if (!template_id) return json({ error: "template_id is required" }, 400);
    const { error } = await callerClient
      .from("whatsapp_message_templates")
      .update({ deleted_at: new Date().toISOString(), deleted_by: caller.id })
      .eq("id", template_id);
    if (error) return json({ error: error.message }, 400);
    return json({ ok: true }, 200);
  }

  // create y sync_status necesitan la línea activa principal del tenant
  // (WABA + token) -- Fase 1 asume una sola WABA por tenant, ver CLAUDE.md.
  const { data: line } = await callerClient
    .from("whatsapp_lines")
    .select("id, business_account_id")
    .eq("tenant_id", tenantId)
    .eq("status", "active")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!line) {
    return json({ error: "No hay ninguna línea de WhatsApp activa para gestionar plantillas." }, 400);
  }

  const { data: accessToken, error: tokenError } = await callerClient.rpc("get_whatsapp_line_access_token", {
    p_line_id: line.id,
  });
  if (tokenError || !accessToken) {
    return json({ error: "No hay un access token configurado para esta línea." }, 400);
  }

  if (action === "create") {
    const { name, category, language, body_text, body_variable_samples } = body;
    if (!name?.trim() || !category || !language?.trim() || !body_text?.trim()) {
      return json({ error: "name, category, language y body_text son obligatorios" }, 400);
    }
    if (!TEMPLATE_CATEGORIES.includes(category)) {
      return json({ error: "category inválida" }, 400);
    }
    const normalizedName = normalizeTemplateName(name);
    if (!normalizedName) {
      return json({ error: "El nombre de la plantilla no puede quedar vacío tras normalizarlo." }, 400);
    }
    const built = buildBodyComponent(body_text, body_variable_samples);
    if ("error" in built) return json({ error: built.error }, 400);

    const metaResp = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${line.business_account_id}/message_templates`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: normalizedName,
        category,
        language,
        components: [built.component],
      }),
    });
    const metaData = await metaResp.json().catch(() => null);
    if (!metaResp.ok) {
      console.error("Failed to create WhatsApp template", metaData);
      return json({ error: metaData?.error?.error_user_msg ?? metaData?.error?.message ?? "No se pudo crear la plantilla en Meta." }, 400);
    }

    const { data: template, error: insertError } = await callerClient
      .from("whatsapp_message_templates")
      .insert({
        tenant_id: tenantId,
        business_account_id: line.business_account_id,
        meta_template_id: metaData?.id ?? null,
        name: normalizedName,
        category,
        language,
        status: metaData?.status ?? "PENDING",
        body_text: body_text.trim(),
        variable_count: built.count,
        created_by: caller.id,
      })
      .select()
      .single();
    if (insertError) return json({ error: insertError.message }, 400);
    return json({ template }, 200);
  }

  if (action === "edit") {
    // Meta permite editar el contenido de una plantilla existente (típico
    // para corregir una RECHAZADA) vía POST /{template_id} en vez de crear
    // un objeto nuevo -- el nombre y el idioma no se pueden cambiar (son la
    // identidad de la plantilla en el WABA), solo el cuerpo. Al editar,
    // Meta vuelve a poner la plantilla en revisión (PENDING).
    const { template_id: templateId, body_text, body_variable_samples } = body;
    if (!templateId || !body_text?.trim()) {
      return json({ error: "template_id y body_text son obligatorios" }, 400);
    }
    const { data: existing } = await callerClient
      .from("whatsapp_message_templates")
      .select("id, category, meta_template_id")
      .eq("id", templateId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (!existing) return json({ error: "Plantilla no encontrada" }, 404);
    if (!existing.meta_template_id) {
      return json({ error: "Esta plantilla no se pudo editar porque no se registró correctamente en Meta." }, 400);
    }
    const built = buildBodyComponent(body_text, body_variable_samples);
    if ("error" in built) return json({ error: built.error }, 400);

    // Meta puede reclasificar la categoría al aprobar (ej. UTILITY -> lo
    // manda a MARKETING según su propio análisis del contenido) sin que
    // nuestra tabla se entere -- si mandamos la categoría vieja que
    // guardamos nosotros, Meta lo interpreta como "querés cambiar la
    // categoría" y una plantilla ya aprobada no permite eso ("No puedes
    // actualizar una categoría de plantilla aprobada"). Se resuelve
    // consultando la categoría real justo antes de editar, nunca confiando
    // en el valor local.
    const currentResp = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${existing.meta_template_id}?fields=category`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const currentData = await currentResp.json().catch(() => null);
    const liveCategory: string = currentResp.ok && currentData?.category ? currentData.category : existing.category;

    const metaResp = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${existing.meta_template_id}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ category: liveCategory, components: [built.component] }),
    });
    const metaData = await metaResp.json().catch(() => null);
    if (!metaResp.ok) {
      console.error("Failed to edit WhatsApp template", metaData);
      return json({ error: metaData?.error?.error_user_msg ?? metaData?.error?.message ?? "No se pudo editar la plantilla en Meta." }, 400);
    }

    const { data: template, error: updateError } = await callerClient
      .from("whatsapp_message_templates")
      .update({ body_text: body_text.trim(), variable_count: built.count, category: liveCategory, status: "PENDING", rejected_reason: null })
      .eq("id", templateId)
      .select()
      .single();
    if (updateError) return json({ error: updateError.message }, 400);
    return json({ template }, 200);
  }

  if (action === "sync_status") {
    const { data: templates } = await callerClient
      .from("whatsapp_message_templates")
      .select("id, name")
      .eq("tenant_id", tenantId)
      .is("deleted_at", null);
    if (!templates || templates.length === 0) return json({ synced: 0 }, 200);

    const metaResp = await fetch(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${line.business_account_id}/message_templates?fields=id,name,status,category,rejected_reason&limit=250`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    const metaData = await metaResp.json().catch(() => null);
    if (!metaResp.ok) {
      console.error("Failed to sync WhatsApp templates", metaData);
      return json({ error: metaData?.error?.message ?? "No se pudo sincronizar el estado de las plantillas." }, 400);
    }

    // Meta puede reclasificar la categoría al revisar (ej. UTILITY ->
    // MARKETING) sin avisar -- se sincroniza acá también, no solo el
    // estado, para que nuestra tabla nunca quede desalineada con lo que
    // Meta realmente tiene (ver acción "edit", que depende de esto).
    const remoteByName = new Map<string, { id: string; status: string; category?: string; rejected_reason?: string }>(
      (metaData?.data ?? []).map((t: { id: string; name: string; status: string; category?: string; rejected_reason?: string }) => [t.name, t]),
    );

    let synced = 0;
    for (const template of templates) {
      const remote = remoteByName.get(template.name);
      if (!remote) continue;
      const { error: updateError } = await callerClient
        .from("whatsapp_message_templates")
        .update({
          status: remote.status,
          category: remote.category ?? undefined,
          rejected_reason: remote.rejected_reason ?? null,
          meta_template_id: remote.id,
        })
        .eq("id", template.id);
      if (!updateError) synced++;
    }
    return json({ synced }, 200);
  }

  return json({ error: "Unknown action" }, 400);
});
