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

/** Shared POST to the line's /messages endpoint -- sendWhatsappText and
 * sendWhatsappImage only differ in the `type`/payload shape, everything
 * about calling the Graph API and interpreting its response is identical.
 * Never throws -- callers persist success or failure into
 * whatsapp_messages.error_message either way. */
async function postGraphMessage(phoneNumberId: string, accessToken: string, payload: Record<string, unknown>): Promise<SendTextMessageResult> {
  try {
    const resp = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ messaging_product: "whatsapp", ...payload }),
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

/** Sends a plain text message via the Graph API using the line's own
 * (already-decrypted) access token. */
export async function sendWhatsappText(phoneNumberId: string, accessToken: string, to: string, body: string): Promise<SendTextMessageResult> {
  return postGraphMessage(phoneNumberId, accessToken, { to, type: "text", text: { body } });
}

/** Sends an image by link -- Meta fetches `link` itself, so it must be
 * reachable without any auth of ours (a short-lived signed URL into the
 * private crm-attachments bucket, see whatsapp-ai-tools::send_attachment and
 * whatsapp-send-human). */
export async function sendWhatsappImage(
  phoneNumberId: string,
  accessToken: string,
  to: string,
  link: string,
  caption?: string,
): Promise<SendTextMessageResult> {
  return postGraphMessage(phoneNumberId, accessToken, { to, type: "image", image: caption ? { link, caption } : { link } });
}

export interface DownloadedMedia {
  bytes: Uint8Array;
  mimeType: string;
}

/** Downloads a media attachment (e.g. an inbound photo) from the Graph API.
 * Two-step dance per Meta's docs: GET /{media-id} resolves a short-lived,
 * authenticated `url` + the mime type, then a second GET against that url
 * (same bearer token) returns the raw bytes. Throws on any failure -- the
 * caller decides how to degrade (e.g. still save the message, just without
 * the image). */
export async function downloadWhatsappMedia(mediaId: string, accessToken: string): Promise<DownloadedMedia> {
  const metaResp = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${mediaId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!metaResp.ok) throw new Error(`Failed to resolve media ${mediaId} (${metaResp.status})`);
  const meta = await metaResp.json();
  if (!meta?.url) throw new Error(`Media ${mediaId} response had no url`);

  const fileResp = await fetch(meta.url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!fileResp.ok) throw new Error(`Failed to download media ${mediaId} bytes (${fileResp.status})`);
  const bytes = new Uint8Array(await fileResp.arrayBuffer());

  return { bytes, mimeType: meta.mime_type ?? fileResp.headers.get("content-type") ?? "application/octet-stream" };
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
