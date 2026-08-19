// Builds context from recent whatsapp_messages, calls the configured AI
// provider (OpenAI or Gemini, stateless per-turn -- see CLAUDE.md 3.3), and
// replies via the Graph API. Internal-only: invoked by whatsapp-webhook using
// the service role key, never meant to be called by a browser client (that
// would let anyone trigger AI replies / burn API credits on any conversation).
//
// Since 2026-08-04 this also drives a bounded tool-calling loop -- the model
// can call functions (create_pqr, create_note, ...) defined in
// _shared/aiTools.ts. Actually executing a tool is delegated to the
// whatsapp-ai-tools function (see its own header comment for why that's a
// separate function instead of inline here), never done directly in this
// file -- this function only ever talks to the LLM.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { json } from "../_shared/cors.ts";
import { requestsHumanHandoff, sendWhatsappText } from "../_shared/whatsapp.ts";
import { toolsForSkills, type AiToolDefinition } from "../_shared/aiTools.ts";

const CONTEXT_MESSAGE_LIMIT = 10;
const HUMAN_HANDOFF_REPLY = "¡Listo! En un momento te atiende un miembro de nuestro equipo.";
const AI_ERROR_FALLBACK_REPLY = "Estamos teniendo un problema técnico en este momento. Un miembro de nuestro equipo te va a contactar pronto.";
// Caps how many times the model can call a tool before we force a final
// reply -- protects against a model that keeps calling tools instead of
// ever answering (runaway latency/cost on a single inbound message).
// Raised from 4 to 8 (2026-08-09): a real turn hit the cap doing
// set_lead_stage + list_pipelines + create_opportunity + list_catalog_products
// -- four legitimate, non-looping calls for one customer message that
// mentioned a product, a quantity, and showed buying intent all at once.
// That's not a runaway loop, just a turn with several tenant-side effects to
// apply -- the cap should catch genuine infinite loops, not normal multi-tool
// turns as more skills get combined on one assistant.
const MAX_TOOL_ROUNDS = 8;

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!isServiceRoleCaller(authHeader)) {
    return json({ error: "Forbidden" }, 403);
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
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const adminClient = createClient(supabaseUrl, serviceRoleKey);

  const { data: conversation } = await adminClient
    .from("whatsapp_conversations")
    .select("id, tenant_id, whatsapp_line_id, contact_phone, contact_id, mode, context_reset_at, campaign_id")
    .eq("id", body.conversation_id)
    .maybeSingle();

  if (!conversation || conversation.mode !== "ia") {
    return json({ skipped: true, reason: "not_in_ia_mode" }, 200);
  }

  const { data: line } = await adminClient
    .from("whatsapp_lines")
    .select("id, phone_number_id, status, ai_assistant_id")
    .eq("id", conversation.whatsapp_line_id)
    .maybeSingle();

  if (!line || line.status !== "active") {
    return json({ skipped: true, reason: "line_not_active" }, 200);
  }

  if (!line.ai_assistant_id) {
    return json({ skipped: true, reason: "no_assistant_assigned" }, 200);
  }

  const { data: assistant } = await adminClient
    .from("ai_assistants")
    .select("id, provider, model, system_prompt, temperature, max_tokens, is_active")
    .eq("id", line.ai_assistant_id)
    .maybeSingle();

  if (!assistant || !assistant.is_active) {
    return json({ skipped: true, reason: "assistant_inactive" }, 200);
  }

  // "Habilidades" (see ai_skills/ai_assistant_skills): which tools this
  // assistant is even allowed to call, and the prompt instructions that
  // teach it how to use them -- both driven by the same enabled-skills set,
  // set per-assistant by the superadmin in the backoffice, never by the
  // tenant's own free-text system_prompt alone.
  const { data: enabledSkillRows } = await adminClient
    .from("ai_assistant_skills")
    .select("ai_skills(key, prompt_fragment)")
    .eq("ai_assistant_id", assistant.id);
  const enabledSkills = (enabledSkillRows ?? [])
    .map((r: { ai_skills: { key: string; prompt_fragment: string } | null }) => r.ai_skills)
    .filter((s): s is { key: string; prompt_fragment: string } => !!s);
  const enabledSkillKeys = new Set(enabledSkills.map((s) => s.key));
  const enabledTools = toolsForSkills(enabledSkillKeys);
  // Global, not per-skill and not per-tenant -- every assistant gets this
  // regardless of what habilidades are enabled or what the tenant wrote in
  // their own system_prompt. Added after a real test (2026-08-09): asked
  // about a product it had already discussed earlier in the same
  // conversation, the model replied "he registrado tu interés" without
  // calling any tool at all that turn -- a true hallucinated action, not a
  // create_opportunity bug (that tool is idempotent and safe to call again,
  // see whatsapp-ai-tools/index.ts). A per-skill instruction can't fix this
  // on its own since it's about how the model talks about ANY tool, not one
  // specific to a single habilidad.
  //
  // Placed first (primacy) with a short repeat appended after the skill
  // fragments (recency) -- a single instance buried in the middle of a long
  // prompt is easy for the model to underweight, this is a hard rule, not a
  // style preference.
  const TOOL_INTEGRITY_RULE =
    'REGLA ESTRICTA, sin excepciones: nunca le digas al cliente que registraste, guardaste, creaste, confirmaste, cancelaste o cambiaste algo si no llamaste la herramienta correspondiente en este mismo turno y esta te devolvió éxito. Contar algo como hecho sin haberlo hecho es peor que no decir nada -- el cliente y el negocio van a confiar en información falsa.\n\n' +
    "Antes de mandar tu respuesta final, revisala frase por frase: por cada frase que afirme una acción (\"quedó registrado\", \"ya lo anoté\", \"listo, confirmado\", \"cancelé tu...\", \"guardé...\"), preguntate si en este turno hiciste la llamada real a la herramienta que la respalda. Si la respuesta es no, tenés dos opciones: llamar la herramienta ahora mismo, o borrar esa frase de tu respuesta -- nunca dejarla así.\n\n" +
    'Ejemplo de lo que NO hay que hacer: el cliente pregunta el precio de un producto que ya se mencionó antes en la conversación; respondés el precio de memoria (está bien, no hace falta re-consultarlo si no cambió), pero además agregás "ya registré tu interés" sin haber llamado a create_opportunity en este turno -- eso es una mentira, aunque sea una mentira sin mala intención.\n\n' +
    'Que "ya lo mencionaste antes en esta conversación" no es lo mismo que "ya llamaste la herramienta antes" -- si no estás segura de haberla llamado ya (por ejemplo, no ves el resultado de esa llamada en los mensajes de este turno o el anterior), volvé a llamarla. Las herramientas de este sistema están hechas para poder llamarse más de una vez sin duplicar nada ni romper nada -- así que ante la duda, llamala.';
  // Global, same reasoning as TOOL_INTEGRITY_RULE above: the model has no
  // built-in notion of "today" (each turn is a stateless call, see CLAUDE.md
  // 3.3), so without this it guesses -- caught for real 2026-08-14, an
  // assistant tried to book an appointment for "mañana" and sent
  // scheduled_at with the wrong year entirely. Computed fresh per request in
  // Colombia's timezone (every tenant so far is Colombian) rather than
  // trusting the model to know the offset from UTC on its own.
  const nowInBogota = new Date();
  const bogotaIsoDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota" }).format(nowInBogota);
  const bogotaHuman = new Intl.DateTimeFormat("es-CO", {
    timeZone: "America/Bogota",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(nowInBogota);
  const CURRENT_DATE_CONTEXT =
    `Fecha y hora actual real (zona horaria de Colombia, America/Bogota): ${bogotaHuman}. En formato ISO, hoy es ${bogotaIsoDate}.\n\n` +
    'Usá esto como referencia real para resolver cualquier fecha relativa que mencione el cliente ("hoy", "mañana", "pasado mañana", "el viernes que viene", "en dos semanas", etc.) -- nunca asumas ni inventes qué día es hoy ni en qué año estás. Cuando llames a una herramienta que reciba una fecha (ej. scheduled_at, expected_close_date), calculá la fecha real a partir de esta referencia, en el formato exacto que pida esa herramienta.';
  // Si esta conversación arrancó de una campaña masiva (ver run-campaigns /
  // CLAUDE.md "iniciar conversaciones", Fase 2), la IA debe seguir esa línea
  // de conversación una vez que el contacto responde -- no solo su prompt
  // genérico. Persiste durante toda la vida de la conversación (decisión
  // explícita del usuario), no solo las primeras respuestas.
  let CAMPAIGN_TOPIC_CONTEXT: string | null = null;
  if (conversation.campaign_id) {
    const { data: campaign } = await adminClient
      .from("campaigns")
      .select("name, topic")
      .eq("id", conversation.campaign_id)
      .maybeSingle();
    if (campaign?.topic?.trim()) {
      CAMPAIGN_TOPIC_CONTEXT =
        `Este contacto te escribió a partir de la campaña de WhatsApp "${campaign.name}": ${campaign.topic.trim()}. ` +
        "Continuá la conversación teniendo esto en cuenta -- es el motivo por el que se está hablando, no lo ignores ni cambies de tema por tu cuenta.";
    }
  }

  const fullSystemPrompt = [
    CURRENT_DATE_CONTEXT,
    TOOL_INTEGRITY_RULE,
    assistant.system_prompt,
    ...enabledSkills.map((s) => s.prompt_fragment),
    CAMPAIGN_TOPIC_CONTEXT,
    TOOL_INTEGRITY_RULE,
  ]
    .filter(Boolean)
    .join("\n\n");

  // A closed-then-reopened conversation gets context_reset_at stamped (see
  // whatsapp-webhook / ChatPanel's "Reabrir conversación") -- everything said
  // before that point is still visible to the tenant in the CRM, but the AI
  // shouldn't see it: it's meant to feel like a genuinely new conversation,
  // not a resumed one. No reset ever happened -> context_reset_at is null ->
  // the query below is unfiltered, same as before this feature existed.
  let contextQuery = adminClient
    .from("whatsapp_messages")
    .select("direction, sender_type, content, created_at, media_storage_path, media_mime_type, media_size_bytes")
    .eq("conversation_id", conversation.id)
    .order("created_at", { ascending: false })
    .limit(CONTEXT_MESSAGE_LIMIT);
  if (conversation.context_reset_at) {
    contextQuery = contextQuery.gte("created_at", conversation.context_reset_at);
  }
  const { data: recentMessages } = await contextQuery;

  const history = (recentMessages ?? []).slice().reverse();
  const lastInbound = [...history].reverse().find((m) => m.direction === "inbound");

  const { data: accessToken } = await adminClient.rpc("get_whatsapp_line_access_token", { p_line_id: line.id });
  if (!accessToken) {
    console.error(`No access token configured for whatsapp_line ${line.id}`);
    return json({ error: "No access token configured for this line" }, 200);
  }

  // Deterministic, not LLM-dependent: a contact asking for a human always
  // hands off immediately, regardless of what the model would have said.
  if (lastInbound && requestsHumanHandoff(lastInbound.content)) {
    await adminClient.from("whatsapp_conversations").update({ mode: "humano" }).eq("id", conversation.id);
    const sendResult = await sendWhatsappText(line.phone_number_id, accessToken, conversation.contact_phone, HUMAN_HANDOFF_REPLY);
    if (sendResult.ok) {
      await insertOutbound(adminClient, conversation.id, HUMAN_HANDOFF_REPLY, sendResult.wamid);
    } else {
      console.error("Failed to send human handoff reply", sendResult.errorMessage);
    }
    return json({ handoff: true, sent: sendResult.ok }, 200);
  }

  // If the message that triggered this turn came with an image (a customer
  // photo the webhook already downloaded), let the tool-calling loop attach
  // it automatically to whatever PQR/seguimiento the model creates/updates
  // -- injected server-side, same trust boundary as tenant_id/contact_id
  // below, the model never sees or chooses this itself.
  const pendingAttachment: PendingAttachment | null =
    lastInbound?.media_storage_path
      ? { storage_path: lastInbound.media_storage_path, mime_type: lastInbound.media_mime_type!, size_bytes: lastInbound.media_size_bytes! }
      : null;
  const conversationContext: ConversationContext = { id: conversation.id, tenant_id: conversation.tenant_id, contact_id: conversation.contact_id, pendingAttachment };

  let replyText: string;
  let tokensUsed: number | null = null;
  try {
    const assistantConfig: AssistantConfig = {
      provider: assistant.provider,
      model: assistant.model,
      system_prompt: fullSystemPrompt,
      temperature: assistant.temperature,
      max_tokens: assistant.max_tokens,
    };
    const completion = await runConversationLoop(adminClient, supabaseUrl, serviceRoleKey, assistantConfig, enabledTools, history, conversationContext);
    replyText = completion.text;
    tokensUsed = completion.tokensUsed;
  } catch (err) {
    console.error("AI provider call failed", err);
    const sendResult = await sendWhatsappText(line.phone_number_id, accessToken, conversation.contact_phone, AI_ERROR_FALLBACK_REPLY);
    // Only record the fallback message in the customer's history if it
    // actually reached them -- see "Bug: mensajes fantasma" in CLAUDE.md.
    // A failed send left no trace for the contact, so it shouldn't appear
    // as if Leadly said something in the conversation.
    if (sendResult.ok) {
      await insertOutbound(adminClient, conversation.id, AI_ERROR_FALLBACK_REPLY, sendResult.wamid);
    } else {
      console.error("Failed to send AI error fallback reply", sendResult.errorMessage);
    }
    return json({ error: "AI provider call failed", sent: sendResult.ok }, 200);
  }

  // Meta AI-Assisted Business Messaging policy (see CLAUDE.md section 6)
  // requires disclosing AI use -- handled via the assistant's own
  // system_prompt (it must state it's a virtual assistant) instead of a
  // hardcoded prefix here, so the disclosure reads as part of the
  // assistant's own voice rather than a bolted-on notice repeated forever.
  const sendResult = await sendWhatsappText(line.phone_number_id, accessToken, conversation.contact_phone, replyText);
  if (sendResult.ok) {
    await insertOutbound(adminClient, conversation.id, replyText, sendResult.wamid, tokensUsed);
  } else {
    console.error("Failed to send AI reply", sendResult.errorMessage);
  }

  return json({ sent: sendResult.ok }, 200);
});

// deno-lint-ignore no-explicit-any
async function insertOutbound(adminClient: any, conversationId: string, content: string, wamid: string | null, tokensUsed: number | null = null) {
  await adminClient.from("whatsapp_messages").insert({
    conversation_id: conversationId,
    direction: "outbound",
    sender_type: "ia",
    content,
    wamid,
    tokens_used: tokensUsed,
  });
}

/** Only whatsapp-webhook (using the project's service role secret) may
 * invoke this function -- otherwise any authenticated browser client could
 * trigger AI replies / burn API credits on any conversation. Compares the
 * bearer token directly against this function's own copy of
 * SUPABASE_SERVICE_ROLE_KEY rather than decoding it as a JWT: Supabase
 * projects can have either the legacy JWT-format service key or the newer
 * `sb_secret_...` format, and Edge Functions are injected with whichever the
 * project uses -- a JWT-decode check silently rejects the newer format. */
function isServiceRoleCaller(authHeader: string): boolean {
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const expected = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  return !!expected && token === expected;
}

interface AssistantConfig {
  provider: string;
  model: string;
  system_prompt: string;
  temperature: number;
  max_tokens: number;
}

interface HistoryMessage {
  direction: string;
  sender_type: string;
  content: string;
  media_storage_path?: string | null;
  media_mime_type?: string | null;
  media_size_bytes?: number | null;
}

interface PendingAttachment {
  storage_path: string;
  mime_type: string;
  size_bytes: number;
}

interface ConversationContext {
  id: string;
  tenant_id: string;
  contact_id: string | null;
  pendingAttachment?: PendingAttachment | null;
}

// Only these tools create/update a PQR -- an image only ever makes sense
// attached to one of those, never to create_note/update_pqr_status/
// get_pqr_status.
const ATTACHABLE_TOOLS = new Set(["create_pqr", "add_pqr_update"]);

interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

type ProviderTurn =
  | { kind: "text"; text: string; tokensUsed: number | null }
  | { kind: "tool_calls"; calls: ToolCall[]; tokensUsed: number | null };

/** Drives the tool-calling loop: ask the provider for a turn, and if it
 * wants to call tools, execute each one via whatsapp-ai-tools and feed the
 * results back before asking again -- up to MAX_TOOL_ROUNDS times, after
 * which whatever text the model has managed to produce wins (or a generic
 * fallback if it never produced any). */
async function runConversationLoop(
  // deno-lint-ignore no-explicit-any
  adminClient: any,
  supabaseUrl: string,
  serviceRoleKey: string,
  assistant: AssistantConfig,
  tools: AiToolDefinition[],
  history: HistoryMessage[],
  conversation: ConversationContext,
): Promise<{ text: string; tokensUsed: number | null }> {
  // deno-lint-ignore no-explicit-any
  const extraTurns: any[] = [];
  let totalTokens = 0;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const turn = await callAiProvider(adminClient, assistant, tools, history, extraTurns);
    totalTokens += turn.tokensUsed ?? 0;

    if (turn.kind === "text") {
      return { text: turn.text, tokensUsed: totalTokens || null };
    }

    // All calls from this one turn must be echoed back as a single
    // assistant/model turn (both providers require the follow-up result
    // turn(s) to immediately match a turn that declared exactly those
    // calls) -- run them in parallel, then append the call turn and result
    // turn(s) together, never interleaved per-call.
    const results = await Promise.all(turn.calls.map((call) => callAiTool(supabaseUrl, serviceRoleKey, call, conversation)));
    appendToolCallTurn(assistant.provider, extraTurns, turn.calls);
    appendToolResultTurns(assistant.provider, extraTurns, turn.calls, results);
  }

  console.error(`Model kept calling tools past ${MAX_TOOL_ROUNDS} rounds for conversation ${conversation.id}`);
  return {
    text: "Perdón, tuve un problema procesando tu solicitud. Un miembro de nuestro equipo te va a contactar pronto.",
    tokensUsed: totalTokens || null,
  };
}

/** Calls whatsapp-ai-tools for a single tool call -- tenant_id/contact_id
 * come from the conversation row (trusted, server-side), never from
 * whatever the model itself put in its call arguments. */
async function callAiTool(
  supabaseUrl: string,
  serviceRoleKey: string,
  call: ToolCall,
  conversation: ConversationContext,
): Promise<unknown> {
  try {
    const resp = await fetch(`${supabaseUrl}/functions/v1/whatsapp-ai-tools`, {
      method: "POST",
      headers: { Authorization: `Bearer ${serviceRoleKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        function_name: call.name,
        parameters: {
          ...call.arguments,
          tenant_id: conversation.tenant_id,
          conversation_id: conversation.id,
          contact_id: conversation.contact_id,
          ...(conversation.pendingAttachment && ATTACHABLE_TOOLS.has(call.name) ? { pending_attachment: conversation.pendingAttachment } : {}),
        },
      }),
    });
    const data = await resp.json();
    return data?.error ? { error: data.error } : (data?.result ?? {});
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Error calling whatsapp-ai-tools" };
  }
}

/** Echoes back the model's own tool-call turn -- required before the result
 * turn(s) below, both providers expect the calls to be declared in a turn
 * of their own first. OpenAI: one `assistant` turn listing every tool_call
 * from this round. Gemini: one `model` turn with one functionCall part per
 * call. */
// deno-lint-ignore no-explicit-any
function appendToolCallTurn(provider: string, extraTurns: any[], calls: ToolCall[]) {
  if (provider === "openai") {
    extraTurns.push({
      role: "assistant",
      content: null,
      tool_calls: calls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } })),
    });
  } else {
    extraTurns.push({ role: "model", parts: calls.map((call) => ({ functionCall: { name: call.name, args: call.arguments } })) });
  }
}

/** Appends the executed results for a round's tool calls, matched up with
 * `appendToolCallTurn` above -- OpenAI wants one `tool` turn per call (each
 * tagged with its own tool_call_id); Gemini wants a single `user` turn with
 * one functionResponse part per call. */
// deno-lint-ignore no-explicit-any
function appendToolResultTurns(provider: string, extraTurns: any[], calls: ToolCall[], results: unknown[]) {
  if (provider === "openai") {
    calls.forEach((call, i) => extraTurns.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(results[i]) }));
  } else {
    extraTurns.push({
      role: "user",
      parts: calls.map((call, i) => ({ functionResponse: { name: call.name, response: results[i] as object } })),
    });
  }
}

async function callAiProvider(
  // deno-lint-ignore no-explicit-any
  adminClient: any,
  assistant: AssistantConfig,
  tools: AiToolDefinition[],
  history: HistoryMessage[],
  // deno-lint-ignore no-explicit-any
  extraTurns: any[],
): Promise<ProviderTurn> {
  if (assistant.provider === "openai") return callOpenAi(adminClient, assistant, tools, history, extraTurns);
  if (assistant.provider === "gemini") return callGemini(adminClient, assistant, tools, history, extraTurns);
  throw new Error(`Unknown provider: ${assistant.provider}`);
}

// deno-lint-ignore no-explicit-any
async function getPlatformAiKey(adminClient: any, provider: "openai" | "gemini"): Promise<string> {
  const { data, error } = await adminClient.rpc("get_platform_ai_key", { p_provider: provider });
  if (error) throw new Error(`Could not read ${provider} key: ${error.message}`);
  if (!data) throw new Error(`${provider === "openai" ? "OPENAI_API_KEY" : "GEMINI_API_KEY"} is not configured`);
  return data as string;
}

async function callOpenAi(
  // deno-lint-ignore no-explicit-any
  adminClient: any,
  assistant: AssistantConfig,
  tools: AiToolDefinition[],
  history: HistoryMessage[],
  // deno-lint-ignore no-explicit-any
  extraTurns: any[],
): Promise<ProviderTurn> {
  const apiKey = await getPlatformAiKey(adminClient, "openai");

  const messages = [
    { role: "system", content: assistant.system_prompt },
    ...history.map((m) => ({ role: m.direction === "inbound" ? "user" : "assistant", content: m.content })),
    ...extraTurns,
  ];

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: assistant.model,
      messages,
      ...(tools.length > 0
        ? { tools: tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } })) }
        : {}),
      temperature: assistant.temperature,
      max_tokens: assistant.max_tokens,
    }),
  });

  const data = await resp.json();
  if (!resp.ok) throw new Error(data?.error?.message ?? `OpenAI error (${resp.status})`);

  const message = data?.choices?.[0]?.message;
  const tokensUsed = data?.usage?.total_tokens ?? null;

  if (message?.tool_calls?.length) {
    const calls: ToolCall[] = message.tool_calls.map((tc: { id: string; function: { name: string; arguments: string } }) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: safeJsonParse(tc.function.arguments),
    }));
    return { kind: "tool_calls", calls, tokensUsed };
  }

  const text = message?.content?.trim();
  if (!text) throw new Error("OpenAI returned an empty response");
  return { kind: "text", text, tokensUsed };
}

async function callGemini(
  // deno-lint-ignore no-explicit-any
  adminClient: any,
  assistant: AssistantConfig,
  tools: AiToolDefinition[],
  history: HistoryMessage[],
  // deno-lint-ignore no-explicit-any
  extraTurns: any[],
): Promise<ProviderTurn> {
  const apiKey = await getPlatformAiKey(adminClient, "gemini");

  const contents = [
    ...history.map((m) => ({ role: m.direction === "inbound" ? "user" : "model", parts: [{ text: m.content }] })),
    ...extraTurns,
  ];

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${assistant.model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: assistant.system_prompt }] },
        contents,
        ...(tools.length > 0
          ? { tools: [{ functionDeclarations: tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })) }] }
          : {}),
        // thinkingBudget: 0 disables Gemini 2.5's internal "thinking" tokens.
        // Found via a real incident (2026-08-09): a customer asked for an
        // elaborate answer (plan de estudios + precio + horarios), the model
        // silently spent the whole maxOutputTokens budget on hidden thinking
        // and returned zero visible text, which this function then treated
        // as a provider error and replied with the generic fallback message.
        // Without this, maxOutputTokens is a budget shared with an
        // invisible process -- a low-latency WhatsApp sales/support bot
        // doesn't need extended reasoning, so all of it should go to the
        // reply the customer actually sees.
        generationConfig: { temperature: assistant.temperature, maxOutputTokens: assistant.max_tokens, thinkingConfig: { thinkingBudget: 0 } },
      }),
    },
  );

  const data = await resp.json();
  if (!resp.ok) throw new Error(data?.error?.message ?? `Gemini error (${resp.status})`);

  const parts = data?.candidates?.[0]?.content?.parts ?? [];
  const tokensUsed = data?.usageMetadata?.totalTokenCount ?? null;

  // deno-lint-ignore no-explicit-any
  const functionCallParts = parts.filter((p: any) => p.functionCall);
  if (functionCallParts.length > 0) {
    // deno-lint-ignore no-explicit-any
    const calls: ToolCall[] = functionCallParts.map((p: any, idx: number) => ({
      id: `${p.functionCall.name}_${idx}`,
      name: p.functionCall.name,
      arguments: p.functionCall.args ?? {},
    }));
    return { kind: "tool_calls", calls, tokensUsed };
  }

  // deno-lint-ignore no-explicit-any
  const text = parts.map((p: any) => p.text).filter(Boolean).join("").trim();
  if (!text) throw new Error("Gemini returned an empty response");
  return { kind: "text", text, tokensUsed };
}

function safeJsonParse(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
