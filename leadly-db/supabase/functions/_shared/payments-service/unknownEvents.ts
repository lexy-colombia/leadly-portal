// Eventos sin destino conocido (rechazo barato de firma mal formada y
// `unknown_link`). Un llamante sin firma valida recibe SIEMPRE la misma
// respuesta (401 invalid_signature): no hay oraculo de existencia -- un link
// que nunca existio y uno que existio en un origen ya retirado responden igual.
// Se registran con payments_record_event (la misma funcion SQL de los links
// propios): con firma invalida queda `invalid_signature`, con firma valida y
// sin link en payments.payment_links queda `unknown_link`.
import { callRpc, logEvent } from "./errors.ts";
import { verifyWompiChecksum } from "./hmac.ts";
import { minimalSummary } from "./eventSupport.ts";
import type { Deps, PayEnvironment, PlatformCredential } from "./types.ts";

export interface EventContext {
  payload: Record<string, unknown>;
  tx: Record<string, unknown>;
  eventMode: PayEnvironment | null;
  respond: (body: unknown, status: number) => Response;
  fail: (code: string, message: string, status: number) => Response;
}

export async function eventSignatureValid(payload: Record<string, unknown>, cred: PlatformCredential, eventMode: PayEnvironment | null): Promise<boolean> {
  if (!eventMode || eventMode !== cred.mode) return false;
  const eventsKey = await cred.getSecret("events_key");
  return !!eventsKey && (await verifyWompiChecksum(payload, eventsKey));
}

/** Registra un evento que no pertenece a ningun link del servicio (solo el resumen minimo acotado). */
async function recordUnattributed(deps: Deps, ctx: EventContext, signatureValid: boolean) {
  return await callRpc<{ event_id: number | string | null; classification: string; throttled?: boolean }>(deps.rpc, "payments_record_event", {
    p_payload: minimalSummary(ctx.payload),
    p_environment: ctx.eventMode,
    p_signature_valid: signatureValid,
  });
}

/** Checksum ausente / mal formado: 401 uniforme sin consultas ni Vault. */
export async function rejectIllFormedSignature(deps: Deps, ctx: EventContext): Promise<Response> {
  const rec = await recordUnattributed(deps, ctx, false);
  logEvent({ level: "warn", event: rec.throttled ? "invalid_signature_throttled" : "invalid_signature_ill_formed" });
  return ctx.fail("invalid_signature", "Firma inválida.", 401);
}

/** Evento sin destino conocido: firma contra la credencial de plataforma. */
export async function handleUnknownEvent(deps: Deps, ctx: EventContext): Promise<Response> {
  const cred = await deps.getPlatformCredential();
  if (!cred) {
    logEvent({ level: "error", event: "platform_credential_unavailable" });
    return ctx.fail("platform_credential_unavailable", "No se puede verificar el evento.", 503);
  }
  const valid = await eventSignatureValid(ctx.payload, cred, ctx.eventMode);
  if (!valid) {
    const rec = await recordUnattributed(deps, ctx, false);
    if (rec.throttled) logEvent({ level: "warn", event: "invalid_signature_throttled" });
    return ctx.fail("invalid_signature", "Firma inválida.", 401);
  }
  const rec = await recordUnattributed(deps, ctx, true);
  return ctx.respond({ ok: true, event_id: rec.event_id, classification: rec.classification }, 200);
}
