/** Cliente mínimo de Resend, compartido por toda la plataforma.
 *
 * Mismo proveedor y mismo dominio verificado que ya usa Lexy legal
 * (`noreply@lexycolombia.com`) -- no hace falta verificar un dominio nuevo.
 * La credencial vive como secreto de Edge Function, nunca en la base ni en
 * el repo.
 *
 * Deliberadamente NO usa el SDK de Resend: la API es un único POST con
 * JSON, y evitar la dependencia mantiene liviana cualquier función que
 * mande correo (las de facturación ya cargan pdf-lib más la pila de firma
 * XML, y ahí el peso importa de verdad). */

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const API_KEY_ENV = "RESEND_API_KEY";

export interface EmailAttachment {
  filename: string;
  /** Contenido en base64 -- lo que espera la API de Resend. */
  content: string;
}

export interface SendEmailInput {
  /** Ej. `"Barriles de la sexta" <noreply@lexycolombia.com>`. El nombre que
   * se muestra es el del comercio, el dominio es el de la plataforma: el
   * comprador reconoce a quién le compró, y no hay que verificar un
   * dominio por tenant. */
  from: string;
  to: string;
  /** Correo real del comercio -- responder le llega a quien vendió, no a
   * un buzón de la plataforma que nadie lee. */
  replyTo?: string | null;
  subject: string;
  html: string;
  attachments?: EmailAttachment[];
}

export interface SendEmailResult {
  ok: boolean;
  /** Id del mensaje en Resend -- se guarda para poder rastrear una entrega
   * puntual en su panel. */
  messageId: string | null;
  error: string | null;
}

/** Manda el correo. NUNCA lanza: devuelve `ok: false` con el motivo, para
 * que el caller lo registre y siga -- ningún flujo de negocio debería
 * caerse porque un proveedor de correo esté caído. */
export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const apiKey = Deno.env.get(API_KEY_ENV);
  if (!apiKey) {
    return { ok: false, messageId: null, error: `Falta el secreto ${API_KEY_ENV} en las Edge Functions.` };
  }
  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: input.from,
        to: [input.to],
        ...(input.replyTo ? { reply_to: input.replyTo } : {}),
        subject: input.subject,
        html: input.html,
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      }),
    });
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, messageId: null, error: `Resend ${res.status}: ${text.slice(0, 500)}` };
    }
    let messageId: string | null = null;
    try {
      messageId = (JSON.parse(text) as { id?: string }).id ?? null;
    } catch {
      messageId = null;
    }
    return { ok: true, messageId, error: null };
  } catch (err) {
    return { ok: false, messageId: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Dirección de envío de la plataforma, con el nombre del comercio como
 * display name. Configurable por si algún día se migra el dominio, pero
 * con un default real para no depender de que el secreto exista. */
export function platformFromAddress(displayName: string | null): string {
  const address = Deno.env.get("EMAIL_FROM_ADDRESS") ?? "noreply@lexycolombia.com";
  if (!displayName) return `Lexy <${address}>`;
  // Comillas + escape: una razón social con coma ("Inversiones, SAS")
  // rompe el header From si va sin comillas.
  const safe = displayName.replace(/["\\]/g, "").trim();
  return `"${safe}" <${address}>`;
}
