// Builds context from recent whatsapp_messages, calls the configured AI
// provider (OpenAI or Gemini, stateless per-turn -- see CLAUDE.md 3.3), and
// replies via the Graph API. Internal-only: invoked by whatsapp-webhook using
// the service role key, never meant to be called by a browser client (that
// would let anyone trigger AI replies / burn API credits on any conversation).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { json } from "../_shared/cors.ts";
import { requestsHumanHandoff, sendWhatsappText } from "../_shared/whatsapp.ts";

const CONTEXT_MESSAGE_LIMIT = 10;
const HUMAN_HANDOFF_REPLY = "¡Listo! En un momento te atiende un miembro de nuestro equipo.";
const AI_ERROR_FALLBACK_REPLY = "Estamos teniendo un problema técnico en este momento. Un miembro de nuestro equipo te va a contactar pronto.";

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
    .select("id, tenant_id, whatsapp_line_id, contact_phone, mode, context_reset_at")
    .eq("id", body.conversation_id)
    .maybeSingle();

  if (!conversation || conversation.mode !== "ia") {
    return json({ skipped: true, reason: "not_in_ia_mode" }, 200);
  }

  const { data: line } = await adminClient
    .from("whatsapp_lines")
    .select("id, phone_number_id, status")
    .eq("id", conversation.whatsapp_line_id)
    .maybeSingle();

  if (!line || line.status !== "active") {
    return json({ skipped: true, reason: "line_not_active" }, 200);
  }

  const { data: assistant } = await adminClient
    .from("ai_assistants")
    .select("provider, model, system_prompt, temperature, max_tokens, is_active")
    .eq("whatsapp_line_id", line.id)
    .maybeSingle();

  if (!assistant || !assistant.is_active) {
    return json({ skipped: true, reason: "assistant_inactive" }, 200);
  }

  // A closed-then-reopened conversation gets context_reset_at stamped (see
  // whatsapp-webhook / ChatPanel's "Reabrir conversación") -- everything said
  // before that point is still visible to the tenant in the CRM, but the AI
  // shouldn't see it: it's meant to feel like a genuinely new conversation,
  // not a resumed one. No reset ever happened -> context_reset_at is null ->
  // the query below is unfiltered, same as before this feature existed.
  let contextQuery = adminClient
    .from("whatsapp_messages")
    .select("direction, sender_type, content, created_at")
    .eq("conversation_id", conversation.id)
    .order("created_at", { ascending: false })
    .limit(CONTEXT_MESSAGE_LIMIT);
  if (conversation.context_reset_at) {
    contextQuery = contextQuery.gte("created_at", conversation.context_reset_at);
  }
  const { data: recentMessages } = await contextQuery;

  const history = (recentMessages ?? []).slice().reverse();
  const lastInbound = [...history].reverse().find((m) => m.direction === "inbound");
  const alreadyRespondedByAi = history.some((m) => m.sender_type === "ia");

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

  let replyText: string;
  let tokensUsed: number | null = null;
  try {
    const completion = await callAiProvider(adminClient, assistant, history);
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

  // Meta AI-Assisted Business Messaging policy (see CLAUDE.md section 6):
  // disclose AI use on the first automated reply of a conversation.
  if (!alreadyRespondedByAi) {
    replyText = `🤖 Este es un asistente virtual con IA.\n\n${replyText}`;
  }

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
}

// deno-lint-ignore no-explicit-any
async function callAiProvider(adminClient: any, assistant: AssistantConfig, history: HistoryMessage[]): Promise<{ text: string; tokensUsed: number | null }> {
  if (assistant.provider === "openai") return callOpenAi(adminClient, assistant, history);
  if (assistant.provider === "gemini") return callGemini(adminClient, assistant, history);
  throw new Error(`Unknown provider: ${assistant.provider}`);
}

// deno-lint-ignore no-explicit-any
async function getPlatformAiKey(adminClient: any, provider: "openai" | "gemini"): Promise<string> {
  const { data, error } = await adminClient.rpc("get_platform_ai_key", { p_provider: provider });
  if (error) throw new Error(`Could not read ${provider} key: ${error.message}`);
  if (!data) throw new Error(`${provider === "openai" ? "OPENAI_API_KEY" : "GEMINI_API_KEY"} is not configured`);
  return data as string;
}

// deno-lint-ignore no-explicit-any
async function callOpenAi(adminClient: any, assistant: AssistantConfig, history: HistoryMessage[]) {
  const apiKey = await getPlatformAiKey(adminClient, "openai");

  const messages = [
    { role: "system", content: assistant.system_prompt },
    ...history.map((m) => ({ role: m.direction === "inbound" ? "user" : "assistant", content: m.content })),
  ];

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: assistant.model,
      messages,
      temperature: assistant.temperature,
      max_tokens: assistant.max_tokens,
    }),
  });

  const data = await resp.json();
  if (!resp.ok) throw new Error(data?.error?.message ?? `OpenAI error (${resp.status})`);

  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("OpenAI returned an empty response");
  return { text, tokensUsed: data?.usage?.total_tokens ?? null };
}

// deno-lint-ignore no-explicit-any
async function callGemini(adminClient: any, assistant: AssistantConfig, history: HistoryMessage[]) {
  const apiKey = await getPlatformAiKey(adminClient, "gemini");

  const contents = history.map((m) => ({
    role: m.direction === "inbound" ? "user" : "model",
    parts: [{ text: m.content }],
  }));

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${assistant.model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: assistant.system_prompt }] },
        contents,
        generationConfig: { temperature: assistant.temperature, maxOutputTokens: assistant.max_tokens },
      }),
    },
  );

  const data = await resp.json();
  if (!resp.ok) throw new Error(data?.error?.message ?? `Gemini error (${resp.status})`);

  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!text) throw new Error("Gemini returned an empty response");
  return { text, tokensUsed: data?.usageMetadata?.totalTokenCount ?? null };
}
