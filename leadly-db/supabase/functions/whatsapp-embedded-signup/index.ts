// Completes WhatsApp Embedded Signup: the tenant already ran through Meta's
// popup flow client-side (see leadly-app/src/lib/metaEmbeddedSignup.ts) and
// got back an OAuth `code` + the waba_id/phone_number_id of the WhatsApp
// Business Account *they* connected. This function does everything that
// must happen server-side (the App Secret can never reach the browser):
//   1. Exchange the code for an access token, then a long-lived one.
//   2. Create the whatsapp_lines + default ai_assistants row.
//   3. Store the token in Vault (write-only, same pattern as a manually
//      entered token).
//   4. Subscribe Leadly's app to that WABA's webhooks so inbound messages
//      route through the existing shared whatsapp-webhook.
//
// Runs with the caller's own JWT for the authorization check (must be a
// tenant_admin), then switches to a service_role client to do the actual
// writes -- a tenant_admin still can't INSERT a whatsapp_lines row directly
// from the browser (see 20260804000007_embedded_signup_service_role.sql),
// only through this vetted path.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, json } from "../_shared/cors.ts";

const GRAPH_API_VERSION = "v21.0";

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

  let body: { code?: string; waba_id?: string; phone_number_id?: string; display_name?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const { code, waba_id, phone_number_id, display_name } = body;
  if (!code || !waba_id || !phone_number_id) {
    return json({ error: "code, waba_id and phone_number_id are required" }, 400);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const metaAppId = Deno.env.get("META_APP_ID")!;
  const metaAppSecret = Deno.env.get("META_APP_SECRET")!;

  const callerClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
  const {
    data: { user: caller },
    error: callerError,
  } = await callerClient.auth.getUser();
  if (callerError || !caller) {
    return json({ error: "Invalid session" }, 401);
  }

  const { data: profile } = await callerClient.from("profiles").select("role, tenant_id").eq("id", caller.id).maybeSingle();
  if (!profile || profile.role !== "tenant_admin" || !profile.tenant_id) {
    return json({ error: "Only a tenant_admin can connect a WhatsApp line" }, 403);
  }
  const tenantId = profile.tenant_id;

  // Step 1: exchange the short-lived code for an access token, then for a
  // long-lived one -- Embedded Signup codes are single-use and the initial
  // token expires quickly.
  const shortLivedResp = await fetch(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/oauth/access_token?client_id=${metaAppId}&client_secret=${metaAppSecret}&code=${encodeURIComponent(code)}`,
  );
  const shortLivedData = await shortLivedResp.json();
  if (!shortLivedResp.ok || !shortLivedData.access_token) {
    console.error("Failed to exchange embedded signup code", shortLivedData);
    return json({ error: shortLivedData?.error?.message ?? "No se pudo intercambiar el código de Meta." }, 400);
  }

  const longLivedResp = await fetch(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/oauth/access_token?grant_type=fb_exchange_token&client_id=${metaAppId}&client_secret=${metaAppSecret}&fb_exchange_token=${shortLivedData.access_token}`,
  );
  const longLivedData = await longLivedResp.json();
  const accessToken = longLivedResp.ok && longLivedData.access_token ? longLivedData.access_token : shortLivedData.access_token;

  const adminClient = createClient(supabaseUrl, serviceRoleKey);

  // Fetch the human-readable phone number (e.g. "+57 313 4931455") -- the
  // tenant only gave us the opaque phone_number_id, and that's all that was
  // stored until now, which made every line in the UI show a meaningless
  // numeric ID instead of the actual WhatsApp number. Best-effort: a failure
  // here shouldn't block the connection, it just leaves the column null.
  let displayPhoneNumber: string | null = null;
  try {
    const phoneResp = await fetch(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${phone_number_id}?fields=display_phone_number`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    const phoneData = await phoneResp.json();
    if (phoneResp.ok) displayPhoneNumber = phoneData.display_phone_number ?? null;
  } catch (err) {
    console.error("Failed to fetch display_phone_number", err);
  }

  // Step 2: create the line + default (inactive) assistant, mirroring
  // leadly-app/src/lib/api/whatsappLines.ts::createWhatsappLine.
  const { data: line, error: lineError } = await adminClient
    .from("whatsapp_lines")
    .insert({
      tenant_id: tenantId,
      phone_number_id,
      business_account_id: waba_id,
      display_name: display_name?.trim() || "WhatsApp",
      display_phone_number: displayPhoneNumber,
      status: "active",
    })
    .select()
    .single();
  if (lineError || !line) {
    console.error("Failed to create whatsapp_line", lineError);
    return json({ error: "No se pudo crear la línea de WhatsApp." }, 500);
  }

  const { data: defaultModel } = await adminClient
    .from("ai_models")
    .select("provider, model_code")
    .eq("provider", "openai")
    .eq("is_active", true)
    .order("display_order", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (defaultModel) {
    const { data: assistant } = await adminClient
      .from("ai_assistants")
      .insert({
        tenant_id: tenantId,
        name: `Asistente de ${line.display_name}`,
        provider: defaultModel.provider,
        model: defaultModel.model_code,
        system_prompt: "",
        is_active: false,
      })
      .select("id")
      .single();
    if (assistant) {
      await adminClient.from("whatsapp_lines").update({ ai_assistant_id: assistant.id }).eq("id", line.id);
    }
  }

  // Step 3: store the token (write-only Vault path, service_role-eligible
  // since migration 20260804000007).
  const { error: tokenError } = await adminClient.rpc("set_whatsapp_line_access_token", {
    p_line_id: line.id,
    p_access_token: accessToken,
  });
  if (tokenError) {
    console.error("Failed to store access token", tokenError);
    await adminClient.from("whatsapp_lines").delete().eq("id", line.id);
    return json({ error: "No se pudo guardar el token de acceso." }, 500);
  }

  // Step 4: subscribe Leadly's app to this WABA's webhooks so inbound
  // messages reach the existing shared whatsapp-webhook. Failure here isn't
  // fatal to line creation -- surface it so the tenant/superadmin knows to
  // retry, but don't roll back a line + token that were saved successfully.
  const subscribeResp = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${waba_id}/subscribed_apps`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const subscribeData = await subscribeResp.json().catch(() => null);
  const subscribed = subscribeResp.ok && subscribeData?.success;
  if (!subscribed) {
    console.error("Failed to subscribe app to WABA webhooks", subscribeData);
  }

  return json({ line, subscribed }, 200);
});
