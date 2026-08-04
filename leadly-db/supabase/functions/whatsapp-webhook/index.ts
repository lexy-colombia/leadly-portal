// Meta WhatsApp Cloud API webhook: GET handshake + POST inbound messages.
// Public endpoint (Meta calls it directly, no user session) -- deployed with
// --no-verify-jwt so Supabase's gateway doesn't require an apikey/JWT, since
// Meta sends neither. Authenticity is instead verified via
// X-Hub-Signature-256 (see _shared/whatsapp.ts) on every POST.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, json } from "../_shared/cors.ts";
import { verifyMetaSignature } from "../_shared/whatsapp.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(req.url);

  if (req.method === "GET") {
    const verifyToken = Deno.env.get("WHATSAPP_VERIFY_TOKEN")!;
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");

    if (mode === "subscribe" && token === verifyToken && challenge) {
      return new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
    }
    return json({ error: "Verification failed" }, 403);
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const rawBody = await req.text();
  const appSecret = Deno.env.get("META_APP_SECRET")!;
  const signatureValid = await verifyMetaSignature(rawBody, req.headers.get("X-Hub-Signature-256"), appSecret);
  if (!signatureValid) {
    return json({ error: "Invalid signature" }, 401);
  }

  let payload: MetaWebhookPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const adminClient = createClient(supabaseUrl, serviceRoleKey);

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages") continue; // ignore status/other webhook fields for v1
      const value = change.value;
      const phoneNumberId = value?.metadata?.phone_number_id;
      if (!phoneNumberId || !value?.messages?.length) continue;

      const { data: line } = await adminClient
        .from("whatsapp_lines")
        .select("id, tenant_id, status")
        .eq("phone_number_id", phoneNumberId)
        .maybeSingle();

      if (!line) continue; // message for a phone_number_id we don't manage -- ignore, don't error the whole batch

      for (const message of value.messages) {
        const contactPhone = message.from;
        const contactName = value.contacts?.find((c) => c.wa_id === contactPhone)?.profile?.name ?? null;
        const content = extractMessageText(message);

        // Every inbound message belongs to a CRM contact -- auto-create one
        // (by tenant+phone) the first time we hear from a number, same as any
        // real CRM's WhatsApp integration would. Never overwrites a name the
        // tenant already edited manually on later messages.
        const { data: existingContact } = await adminClient
          .from("crm_contacts")
          .select("id")
          .eq("tenant_id", line.tenant_id)
          .eq("phone", contactPhone)
          .maybeSingle();

        let contactId = existingContact?.id ?? null;
        if (!contactId) {
          const { data: newContact } = await adminClient
            .from("crm_contacts")
            .insert({ tenant_id: line.tenant_id, phone: contactPhone, full_name: contactName ?? contactPhone })
            .select("id")
            .single();
          contactId = newContact?.id ?? null;
        }

        const { data: conversation, error: convError } = await adminClient
          .from("whatsapp_conversations")
          .upsert(
            {
              tenant_id: line.tenant_id,
              whatsapp_line_id: line.id,
              contact_phone: contactPhone,
              contact_name: contactName,
              contact_id: contactId ?? null,
            },
            { onConflict: "whatsapp_line_id,contact_phone", ignoreDuplicates: false },
          )
          .select()
          .single();

        if (convError || !conversation) continue;

        // contact_name can change between messages (they update their WhatsApp
        // profile); keep it current without clobbering an admin-edited value on
        // every single inbound message would need a separate "source" flag --
        // out of scope for v1, just keep the latest one Meta reports.
        if (contactName && contactName !== conversation.contact_name) {
          await adminClient.from("whatsapp_conversations").update({ contact_name: contactName }).eq("id", conversation.id);
        }

        // A contact writing back into a *closed* conversation is treated as
        // starting fresh: reopen it, reset the AI's context boundary (see
        // whatsapp-ai-respond), and hand it back to the AI by default -- the
        // full history still stays visible in the CRM, this only affects
        // what the AI sees and how the conversation behaves going forward.
        if (conversation.status === "closed") {
          await adminClient
            .from("whatsapp_conversations")
            .update({ status: "open", context_reset_at: new Date().toISOString(), mode: "ia" })
            .eq("id", conversation.id);
          conversation.status = "open";
          conversation.mode = "ia";
        }

        await adminClient.from("whatsapp_messages").insert({
          conversation_id: conversation.id,
          direction: "inbound",
          sender_type: "contact",
          content,
          wamid: message.id,
        });

        if (conversation.mode === "ia" && line.status === "active") {
          // Must be awaited: Supabase Edge Functions (like Deno Deploy) tear
          // down any in-flight, un-awaited work as soon as the handler
          // returns a Response, so a bare fire-and-forget fetch() here would
          // get killed before whatsapp-ai-respond ever ran. The extra
          // latency is fine -- Meta's webhook timeout is generous.
          try {
            await fetch(`${supabaseUrl}/functions/v1/whatsapp-ai-respond`, {
              method: "POST",
              headers: { Authorization: `Bearer ${serviceRoleKey}`, "Content-Type": "application/json" },
              body: JSON.stringify({ conversation_id: conversation.id }),
            });
          } catch (err) {
            console.error("Failed to invoke whatsapp-ai-respond", err);
          }
        }
      }
    }
  }

  return json({ received: true }, 200);
});

function extractMessageText(message: MetaMessage): string {
  if (message.type === "text" && message.text?.body) return message.text.body;
  if (message.type === "button" && message.button?.text) return message.button.text;
  if (message.type === "interactive" && message.interactive?.button_reply?.title) return message.interactive.button_reply.title;
  if (message.type === "interactive" && message.interactive?.list_reply?.title) return message.interactive.list_reply.title;
  return `[mensaje no soportado: ${message.type}]`;
}

interface MetaMessage {
  from: string;
  id: string;
  type: string;
  text?: { body: string };
  button?: { text: string };
  interactive?: { button_reply?: { title: string }; list_reply?: { title: string } };
}

interface MetaWebhookPayload {
  entry?: {
    changes?: {
      field: string;
      value: {
        metadata?: { phone_number_id: string };
        contacts?: { wa_id: string; profile?: { name?: string } }[];
        messages?: MetaMessage[];
      };
    }[];
  }[];
}
