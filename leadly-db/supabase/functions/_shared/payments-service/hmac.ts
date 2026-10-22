// Primitivas criptográficas del servicio: sha256, HMAC-SHA256, comparación en
// tiempo constante, JSON canónico (para request_hash) y checksum de Wompi.

const enc = new TextEncoder();

function toHex(buf: ArrayBuffer | Uint8Array): string {
  return Array.from(buf instanceof Uint8Array ? buf : new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(input: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(input)));
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

/** Compara dos strings en tiempo constante respecto de su contenido y largo:
 * ambas se reducen primero a un digest SHA-256 de largo fijo y se comparan
 * con un OR acumulado (sin salida temprana). */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)).then((x) => new Uint8Array(x)),
    crypto.subtle.digest("SHA-256", enc.encode(b)).then((x) => new Uint8Array(x)),
  ]);
  let diff = 0;
  for (let i = 0; i < da.length; i++) diff |= da[i] ^ db[i];
  return diff === 0;
}

/** JSON con claves ordenadas -- misma entrada lógica, mismo hash. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

/** Cabecera Payments-Signature (spec §4): t=<unix>,v1=<hex(HMAC(secret, t + "." + rawBody))> */
export async function signEnvelope(signingSecret: string, rawBody: string, unixSeconds: number): Promise<string> {
  const v1 = await hmacSha256Hex(signingSecret, `${unixSeconds}.${rawBody}`);
  return `t=${unixSeconds},v1=${v1}`;
}

export const ENVELOPE_TOLERANCE_SECONDS = 300;

/** Verifica la cabecera Payments-Signature de un aviso (inverso de signEnvelope):
 * HMAC sobre `t + "." + rawBody` (bytes crudos), comparación en tiempo constante
 * y tolerancia de reloj de ±toleranceSeconds (anti-replay). Cualquier forma
 * inválida de la cabecera devuelve false (sin distinguir el motivo). */
export async function verifyEnvelopeSignature(
  signingSecret: string,
  header: string | null,
  rawBody: string,
  nowUnixSeconds: number,
  toleranceSeconds = ENVELOPE_TOLERANCE_SECONDS,
): Promise<boolean> {
  if (!header || header.length > 512 || !signingSecret) return false;
  let t: number | null = null;
  const candidates: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === "t" && /^\d{1,12}$/.test(v)) t = Number(v);
    else if (k === "v1" && /^[0-9a-fA-F]{64}$/.test(v)) candidates.push(v.toLowerCase());
  }
  if (t === null || candidates.length === 0) return false;
  if (Math.abs(nowUnixSeconds - t) > toleranceSeconds) return false;
  const expected = await hmacSha256Hex(signingSecret, `${t}.${rawBody}`);
  let ok = false;
  for (const c of candidates) ok = (await timingSafeEqual(expected, c)) || ok;
  return ok;
}

export const REQUIRED_SIGNED_PROPERTIES = ["transaction.id", "transaction.status", "transaction.amount_in_cents"] as const;

function resolvePath(obj: unknown, path: string): unknown {
  return path.split(".").reduce((val: unknown, part) => (val as Record<string, unknown> | undefined)?.[part], obj);
}

/** Checksum de un evento de Wompi (docs.wompi.co/docs/colombia/eventos):
 * SHA-256( valores de signature.properties (rutas relativas a `data`) + timestamp + secreto de eventos ).
 * Devuelve null si el evento no trae lo necesario. Algoritmo probado en
 * producción (el de la integración original de Wompi, ya retirada); sin log
 * del hash y con comparación en tiempo constante. */
export async function wompiExpectedChecksum(payload: unknown, eventsKey: string): Promise<string | null> {
  const body = payload as {
    data?: unknown;
    signature?: { properties?: unknown };
    timestamp?: unknown;
  };
  const props = body?.signature?.properties;
  if (!Array.isArray(props) || props.length === 0 || props.length > 20 || !props.every((p) => typeof p === "string")) return null;
  if (body.timestamp === undefined || body.timestamp === null || body.timestamp === "") return null;
  // B2 (review): la firma de Wompi solo vale por lo que el propio payload
  // declara firmar. Se exige que cubra, como mínimo, id, status y monto.
  for (const required of REQUIRED_SIGNED_PROPERTIES) {
    if (!(props as string[]).includes(required)) return null;
  }
  const concatenated = (props as string[]).map((p) => String(resolvePath(body.data, p) ?? "")).join("");
  return await sha256Hex(concatenated + String(body.timestamp) + eventsKey);
}

export async function verifyWompiChecksum(payload: unknown, eventsKey: string): Promise<boolean> {
  const provided = (payload as { signature?: { checksum?: unknown } })?.signature?.checksum;
  if (typeof provided !== "string" || provided.length === 0) return false;
  const expected = await wompiExpectedChecksum(payload, eventsKey);
  if (expected === null) return false;
  return await timingSafeEqual(expected.toLowerCase(), provided.toLowerCase());
}
