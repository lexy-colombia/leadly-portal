// Shared helpers for talking to Meta's WhatsApp Cloud API and validating its
// webhook signature. Used by whatsapp-webhook, whatsapp-ai-respond and
// whatsapp-send-human.

const GRAPH_API_VERSION = "v21.0";

/** Verifies X-Hub-Signature-256 (HMAC-SHA256 of the raw body, keyed by the
 * Meta App Secret) using the raw, unparsed request body -- signing is over
 * exact bytes, so this must run before any JSON.parse of the payload. */
export async function verifyMetaSignature(rawBody: string, signatureHeader: string | null, appSecret: string): Promise<boolean> {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  const expectedHex = signatureHeader.slice("sha256=".length);

  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(appSecret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const signatureBuffer = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const computedHex = [...new Uint8Array(signatureBuffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

  if (computedHex.length !== expectedHex.length) return false;
  // Constant-time-ish comparison -- avoids leaking timing info about how much
  // of the signature matched (a timing side-channel is not the most likely
  // attack here, but it costs nothing to close it).
  let diff = 0;
  for (let i = 0; i < computedHex.length; i++) diff |= computedHex.charCodeAt(i) ^ expectedHex.charCodeAt(i);
  return diff === 0;
}

export interface SendTextMessageResult {
  ok: boolean;
  wamid: string | null;
  errorMessage: string | null;
}

/** Sends a plain text message via the Graph API using the line's own
 * (already-decrypted) access token. Never throws -- callers persist success
 * or failure into whatsapp_messages.error_message either way. */
export async function sendWhatsappText(phoneNumberId: string, accessToken: string, to: string, body: string): Promise<SendTextMessageResult> {
  try {
    const resp = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body },
      }),
    });

    const json = await resp.json().catch(() => null);
    if (!resp.ok) {
      return { ok: false, wamid: null, errorMessage: json?.error?.message ?? `Graph API error (${resp.status})` };
    }
    const wamid = json?.messages?.[0]?.id ?? null;
    return { ok: true, wamid, errorMessage: null };
  } catch (err) {
    return { ok: false, wamid: null, errorMessage: err instanceof Error ? err.message : "Unknown error calling Graph API" };
  }
}

/** Meta's 2026 AI-Assisted Business Messaging policy requires disclosing AI
 * use and a clear path to a human -- see CLAUDE.md section 6. Phrases a
 * contact can send to force a handoff to a human agent. */
const HUMAN_HANDOFF_PHRASES = [
  "hablar con humano",
  "hablar con un humano",
  "hablar con una persona",
  "hablar con alguien",
  "agente humano",
  "atencion humana",
  "atención humana",
  "quiero un asesor",
  "quiero hablar con alguien",
];

export function requestsHumanHandoff(text: string): boolean {
  const normalized = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, ""); // strip accents so "atención"/"atencion" both match
  return HUMAN_HANDOFF_PHRASES.some((phrase) => normalized.includes(phrase.normalize("NFD").replace(/[̀-ͯ]/g, "")));
}
