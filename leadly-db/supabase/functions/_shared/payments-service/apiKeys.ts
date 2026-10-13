// API keys de proyectos: lxy_pay_<test|live>_<8>_<43 base64url>.
// Solo se guarda sha256(key) (hex). La clave en claro se devuelve UNA vez.
import { sha256Hex } from "./hmac.ts";
import { ApiError, callRpc } from "./errors.ts";
import type { AuthenticatedClient, PayEnvironment, RpcClient } from "./types.ts";

const API_KEY_RE = /^lxy_pay_(test|live)_([A-Za-z0-9_-]{8})_([A-Za-z0-9_-]{43})$/;

function randomBase64Url(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function envFromKeySegment(seg: "test" | "live"): PayEnvironment {
  return seg === "test" ? "sandbox" : "production";
}

export interface GeneratedKey {
  apiKey: string;
  keyHash: string;
  keyPrefix: string;
}

export async function generateApiKey(env: PayEnvironment): Promise<GeneratedKey> {
  const seg = env === "sandbox" ? "test" : "live";
  const id = randomBase64Url(6); // 8 caracteres
  const secret = randomBase64Url(32); // 43 caracteres
  const apiKey = `lxy_pay_${seg}_${id}_${secret}`;
  return { apiKey, keyHash: await sha256Hex(apiKey), keyPrefix: `lxy_pay_${seg}_${id}` };
}

/** Secreto de firma del sobre (HMAC) -- 256 bits aleatorios. */
export function generateSigningSecret(): string {
  return `lxy_whsec_${randomBase64Url(32)}`;
}

export function extractBearer(authHeader: string | null): string | null {
  const m = authHeader?.match(/^Bearer\s+(\S+)$/i);
  return m ? m[1] : null;
}

/** Autentica una petición de proyecto. Lanza ApiError 401 con cuerpo propio.
 * La clave nunca se compara en claro: se busca por su sha256 (índice único en
 * la base); no hay comparación de la clave contra un valor almacenado. */
export async function authenticateClient(rpc: RpcClient, authHeader: string | null): Promise<AuthenticatedClient> {
  const token = extractBearer(authHeader);
  const unauthorized = new ApiError(401, "unauthorized", "API key ausente o inválida.", { "WWW-Authenticate": "Bearer" });
  if (!token) throw unauthorized;
  const m = token.match(API_KEY_RE);
  if (!m) throw unauthorized;
  const hash = await sha256Hex(token);
  let found: Record<string, unknown> | null;
  try {
    found = await callRpc<Record<string, unknown> | null>(rpc, "payments_lookup_client", { p_key_hash: hash });
  } catch (e) {
    // PY404 no debería ocurrir (devuelve null), pero cualquier fallo de lookup NO autentica.
    if (e instanceof ApiError && e.status === 404) throw unauthorized;
    throw e;
  }
  if (!found || typeof found.id !== "string") throw unauthorized;
  if (found.status !== undefined && found.status !== "active") throw unauthorized;
  return {
    id: found.id,
    name: String(found.name ?? ""),
    status: String(found.status ?? "active"),
    callback_url: (found.callback_url as string | null) ?? null,
    signing_secret_name: (found.signing_secret_name as string | null) ?? null,
    environment: envFromKeySegment(m[1] as "test" | "live"),
  };
}
