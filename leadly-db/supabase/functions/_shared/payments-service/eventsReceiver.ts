// Receptor UNICO de los eventos de Wompi (POST /v1/events/wompi). Orden:
//  1. parsear (si falla -> `malformed`, 200);
//  2. link del servicio nuevo (payments.payment_links) -> flujo de este archivo;
//  3. si no, destino legacy de `public` (factura de plataforma, link de pedido
//     de un tenant) -> legacyOrigins.ts (firma del merchant correcto,
//     confirmacion contra Wompi, monto esperado, anti-replay);
//  4. si no es de ninguno -> `unknown_link` (200) si la firma de la plataforma
//     es valida; un llamante sin firma valida recibe 401 SIEMPRE, exista o no
//     el link (sin oraculo de existencia).
// Ya no se reenvia nada a payment-webhook-wompi (retirado).
import { callRpc, logEvent } from "./errors.ts";
import { verifyWompiChecksum } from "./hmac.ts";
import { dispatchDue } from "./deliveries.ts";
import { hasWellFormedSignature, minimalSummary, verifyTransaction, wompiEnvToMode } from "./eventSupport.ts";
import type { Verified } from "./eventSupport.ts";
import { handleLegacyTarget, handleUnknownEvent, rejectIllFormedSignature } from "./legacyOrigins.ts";
import type { EventContext } from "./legacyOrigins.ts";
import type { Deps, PayEnvironment } from "./types.ts";

export { wompiEnvToMode };
export const MAX_EVENT_BYTES = 256 * 1024;

interface FoundLink {
  id: string;
  client_id: string;
  environment: PayEnvironment;
  status: string;
  amount_in_cents: number;
  currency: string;
}

async function recordMalformed(deps: Deps, reason: string, rawText: string) {
  try {
    await callRpc(deps.rpc, "payments_record_event", {
      p_payload: { _malformed: true, reason, raw_text: rawText.slice(0, 2000) },
      p_environment: null,
      p_signature_valid: null,
    });
  } catch (e) {
    logEvent({ level: "error", event: "record_malformed_failed", message: e instanceof Error ? e.message : String(e) });
  }
}

export async function handleWompiEvent(deps: Deps, req: Request, requestId: string): Promise<Response> {
  const json = (body: unknown, status: number) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "X-Request-Id": requestId } });
  const err = (code: string, message: string, status: number) => json({ error: { code, message, request_id: requestId } }, status);

  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_EVENT_BYTES) return err("payload_too_large", "Evento demasiado grande.", 413);
  const rawText = await req.text();
  if (new TextEncoder().encode(rawText).length > MAX_EVENT_BYTES) return err("payload_too_large", "Evento demasiado grande.", 413);

  // 1. parseo
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(rawText);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not_object");
    payload = parsed as Record<string, unknown>;
  } catch {
    await recordMalformed(deps, "invalid_json", rawText);
    return json({ ok: true, classification: "malformed" }, 200);
  }
  const tx = (payload.data as Record<string, unknown> | undefined)?.transaction as Record<string, unknown> | undefined;
  if (!tx || typeof tx !== "object") {
    await recordMalformed(deps, "no_transaction", rawText);
    return json({ ok: true, classification: "malformed" }, 200);
  }

  const ctx: EventContext = {
    payload,
    tx,
    eventMode: wompiEnvToMode(payload.environment),
    respond: json,
    fail: err,
  };

  // 1b. descarte barato: sin checksum SHA-256 hex de 64 caracteres no hay nada que
  // verificar. Ninguna consulta ni descifrado de Vault; solo un resumen minimo acotado.
  if (!hasWellFormedSignature(payload)) return await rejectIllFormedSignature(deps, ctx);

  // 2. ¿link del servicio nuevo?
  const wompiLinkId = typeof tx.payment_link_id === "string" && tx.payment_link_id.length > 0 ? tx.payment_link_id : null;
  let link: FoundLink | null = null;
  if (wompiLinkId) {
    link = await callRpc<FoundLink | null>(deps.rpc, "payments_find_link_by_wompi_id", { p_wompi_link_id: wompiLinkId });
  }

  // 3. destino legacy (factura de plataforma / link de pedido) o desconocido
  if (!link) {
    if (wompiLinkId) {
      const target = await deps.legacy.find(wompiLinkId);
      if (target === "ambiguous") {
        // Mas de una fila para el mismo checkout: no se paga nada; con firma de
        // plataforma valida queda `legacy_not_applied` (visible en health) + alerta.
        logEvent({ level: "critical", event: "legacy_ambiguous_checkout", request_id: requestId });
        return await handleUnknownEvent(deps, ctx, { ambiguous: true });
      } else if (target) {
        return await handleLegacyTarget(deps, ctx, target);
      }
    }
    return await handleUnknownEvent(deps, ctx);
  }

  // 4. propio -> firma con el events_key del ambiente del evento
  const eventMode = ctx.eventMode;
  const credential = await deps.getPlatformCredential();
  if (!credential) {
    logEvent({ level: "error", event: "platform_credential_unavailable", link_id: link.id });
    return err("platform_credential_unavailable", "No se puede verificar el evento.", 503);
  }
  let signatureValid = false;
  if (eventMode && eventMode === credential.mode) {
    const eventsKey = await credential.getSecret("events_key");
    signatureValid = !!eventsKey && (await verifyWompiChecksum(payload, eventsKey));
  }

  // 4b. toda APPROVED de un link propio se confirma contra Wompi antes de
  // registrarse (el checksum no cubre payment_link_id ni currency).
  let verified: Verified = null;
  let verifyRetryable = false;
  if (signatureValid && tx.status === "APPROVED") {
    const txId = typeof tx.id === "string" ? tx.id : null;
    if (!txId) {
      verifyRetryable = false; // sin id no hay nada que consultar: P1 lo clasificará
    } else {
      const privateKey = await credential.getSecret("private_key");
      const v = await verifyTransaction(deps, credential.mode, privateKey, txId);
      verified = v.verified;
      verifyRetryable = v.retryable;
    }
  }

  // 5. registrar (también el inválido)
  const result = await callRpc<{
    event_id: number | string;
    classification: string;
    link_id: string | null;
    client_id: string | null;
    link_status: string | null;
    deliveries: Array<{ id: string; url: string }>;
    throttled?: boolean;
  }>(deps.rpc, "payments_record_event", {
    // Sin firma valida solo se guarda el resumen minimo acotado (B1 revision final).
    p_payload: signatureValid ? payload : minimalSummary(payload),
    p_environment: eventMode,
    p_signature_valid: signatureValid,
    p_verified: verified,
  });

  if (!signatureValid) {
    logEvent({ level: "warn", event: result.throttled ? "invalid_signature_throttled" : "invalid_signature", request_id: requestId, link_id: link.id });
    return err("invalid_signature", "Firma inválida.", 401);
  }

  if (verifyRetryable) {
    // El evento quedó guardado como `unverified`; 503 para que Wompi reintente.
    return err("verification_unavailable", "No se pudo confirmar la transacción con Wompi; reintenta.", 503);
  }

  // Tripwire: P1 es la autoridad del monto/moneda; si el evento no coincide con
  // el link y aun así quedó como procesado, es una divergencia grave.
  const amountOk = Number(tx.amount_in_cents) === Number(link.amount_in_cents) && tx.currency === link.currency;
  if (!amountOk && result.classification === "processed") {
    logEvent({ level: "critical", event: "amount_guard_divergence", link_id: link.id, event_id: result.event_id });
  }

  // 6. entrega inmediata (nunca cambia la respuesta a Wompi)
  let delivery: unknown = null;
  if (result.deliveries && result.deliveries.length > 0) {
    try {
      // claim_deliveries reclama las vencidas más antiguas (no por id): se reclama
      // un lote de 5 para que la recién encolada entre aunque haya pendientes viejas.
      delivery = await dispatchDue(deps, Math.max(5, result.deliveries.length));
    } catch (e) {
      logEvent({ level: "error", event: "immediate_dispatch_failed", message: e instanceof Error ? e.message : String(e) });
    }
  }
  return json({ ok: true, event_id: result.event_id, classification: result.classification, delivery }, 200);
}
