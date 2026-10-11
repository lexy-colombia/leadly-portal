// Piezas compartidas por el receptor de eventos de Wompi (links del servicio
// nuevo y origenes legacy): mapeo de ambiente, resumen minimo sin datos
// personales y confirmacion de una transaccion contra la API de Wompi.
import { logEvent } from "./errors.ts";
import { VERIFY_TIMEOUT_MS } from "./types.ts";
import { WOMPI_API } from "./wompiLinks.ts";
import type { Deps, PayEnvironment } from "./types.ts";

export function wompiEnvToMode(env: unknown): PayEnvironment | null {
  if (env === "test") return "sandbox";
  if (env === "prod") return "production";
  return null;
}

/** Valor acotado: strings recortados, numeros/null tal cual, todo lo demas null
 * (el resumen es lo unico que se guarda de un evento sin firma valida: debe pesar
 * unos pocos KB sin importar lo que mande el llamante). */
function clip(v: unknown, max = 128): string | number | null {
  if (typeof v === "string") return v.slice(0, max);
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}

/** Resumen sin datos personales (para eventos sin firma valida / sin destino). */
export function minimalSummary(payload: Record<string, unknown>) {
  const tx = ((payload.data as Record<string, unknown> | undefined)?.transaction ?? {}) as Record<string, unknown>;
  return {
    event: clip(payload.event),
    environment: clip(payload.environment),
    sent_at: clip(payload.sent_at),
    timestamp: clip(payload.timestamp),
    data: {
      transaction: {
        id: clip(tx.id),
        status: clip(tx.status),
        amount_in_cents: clip(tx.amount_in_cents),
        currency: clip(tx.currency),
        payment_link_id: clip(tx.payment_link_id),
      },
    },
  };
}

/** Descarte barato ANTES de cualquier consulta / descifrado: el checksum de
 * Wompi es SHA-256 en hex (64 caracteres) y properties debe ser un arreglo. */
export function hasWellFormedSignature(payload: Record<string, unknown>): boolean {
  const sig = payload.signature as { checksum?: unknown; properties?: unknown } | undefined;
  return !!sig && typeof sig.checksum === "string" && /^[0-9a-fA-F]{64}$/.test(sig.checksum) && Array.isArray(sig.properties);
}

export type Verified = Record<string, unknown> | null;

/** Confirma una APPROVED con GET {api}/transactions/{id} (llave privada del
 * merchant). Devuelve el `data` de Wompi, {_not_found:true} si 404, o null si
 * no se pudo consultar (red/5xx/timeout/401/403 -> el caller responde 503). */
export async function verifyTransaction(
  deps: Deps,
  mode: PayEnvironment,
  privateKey: string | null,
  txId: string,
): Promise<{ verified: Verified; retryable: boolean }> {
  if (!privateKey) {
    logEvent({ level: "critical", event: "verify_private_key_missing" });
    return { verified: null, retryable: true };
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), deps.timeouts?.verifyMs ?? VERIFY_TIMEOUT_MS);
  try {
    const res = await deps.fetch(`${WOMPI_API[mode]}/transactions/${encodeURIComponent(txId)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${privateKey}` },
      signal: ctl.signal,
      redirect: "error",
    });
    const text = await res.text();
    if (res.status === 404) return { verified: { _not_found: true }, retryable: false };
    if (res.status === 401 || res.status === 403) {
      logEvent({ level: "critical", event: "verify_private_key_rejected", http_status: res.status });
      return { verified: null, retryable: true };
    }
    if (!res.ok) {
      logEvent({ level: "error", event: "verify_http_error", http_status: res.status });
      return { verified: null, retryable: true };
    }
    const data = (JSON.parse(text) as { data?: unknown })?.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) return { verified: null, retryable: true };
    return { verified: data as Record<string, unknown>, retryable: false };
  } catch (e) {
    logEvent({ level: "error", event: "verify_failed", reason: e instanceof Error ? e.name : "error" });
    return { verified: null, retryable: true };
  } finally {
    clearTimeout(timer);
  }
}
