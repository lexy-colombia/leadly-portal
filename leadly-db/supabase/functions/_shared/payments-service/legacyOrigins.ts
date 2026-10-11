// Origenes legacy del receptor de Wompi (fusion de payment-webhook-wompi en
// payments-api). Un evento cuyo link no es del servicio nuevo se resuelve
// contra, en este orden:
//   (2) public.payment_invoices            -> Lexy cobrandole a un tenant
//   (3) public.sales_order_payment_links   -> un tenant cobrandole a su cliente
// y si no es de ninguno queda como `unknown_link`.
//
// Endurecimiento (el webhook viejo no lo tenia: registraba el monto DEL EVENTO
// sin compararlo, no confirmaba con Wompi y no impedia que una misma
// transaccion acreditara varios destinos):
//  a. firma con el events_key del merchant CORRECTO (plataforma o tenant) y que
//     signature.properties cubra transaction.id/status/amount_in_cents (hmac.ts);
//  b. toda APPROVED se confirma con GET /transactions/{id} (llave privada de ESE
//     merchant): id, estado, payment_link_id, monto y moneda; red caida -> 503;
//  c. el monto del evento se compara contra el monto ESPERADO almacenado en el
//     destino (payment_invoices.amount_cents / sales_order_payment_links.amount,
//     que es el valor que se le pidio a Wompi al crear el cobro; nunca el saldo
//     recalculado hoy). Sin monto esperado => no se paga (falla cerrada);
//  d. una transaccion ya aplicada a otro destino (en payments.events o en las
//     tablas legacy) no puede acreditar un segundo;
//  e. idempotencia y orden de eventos: se reutilizan applyWebhookEvent /
//     applySalesOrderPaymentWebhookEvent, que solo actuan sobre un destino
//     pendiente (un DECLINED posterior a un pago nunca lo regresa).
// Un llamante sin firma valida recibe SIEMPRE la misma respuesta (401
// invalid_signature) exista o no el link: no hay oraculo de existencia.
import { callRpc, logEvent } from "./errors.ts";
import { verifyWompiChecksum } from "./hmac.ts";
import { minimalSummary, verifyTransaction } from "./eventSupport.ts";
import type { Deps, LegacyTarget, PayEnvironment, PlatformCredential } from "./types.ts";

export interface EventContext {
  payload: Record<string, unknown>;
  tx: Record<string, unknown>;
  eventMode: PayEnvironment | null;
  respond: (body: unknown, status: number) => Response;
  fail: (code: string, message: string, status: number) => Response;
}

type UsageRow = { wompi_link_id: string | null; tx_status: string | null; classification: string; origin: string | null; origin_ref: string | null };

const APPLIED_CLASSES = new Set(["processed", "duplicate_payment", "legacy_invoice", "legacy_order_payment"]);

export async function eventSignatureValid(payload: Record<string, unknown>, cred: PlatformCredential, eventMode: PayEnvironment | null): Promise<boolean> {
  if (!eventMode || eventMode !== cred.mode) return false;
  const eventsKey = await cred.getSecret("events_key");
  return !!eventsKey && (await verifyWompiChecksum(payload, eventsKey));
}

async function recordLegacy(
  deps: Deps,
  payload: unknown,
  eventMode: PayEnvironment | null,
  signatureValid: boolean | null,
  classification: string,
  target: LegacyTarget | null,
  originRef: string | null = null,
) {
  return await callRpc<{ event_id: number | string | null; classification: string; throttled?: boolean }>(deps.rpc, "payments_record_legacy_event", {
    p_payload: payload,
    p_environment: eventMode,
    p_signature_valid: signatureValid,
    p_classification: classification,
    p_origin: target ? (target.origin === "invoice" ? "legacy_invoice" : "legacy_order") : null,
    p_origin_ref: target ? target.id : originRef,
    p_expected_cents: target?.expectedCents ?? null,
    p_expected_currency: target?.currency ?? null,
  });
}

/** Checksum ausente / mal formado: 401 uniforme sin consultas ni Vault. */
export async function rejectIllFormedSignature(deps: Deps, ctx: EventContext): Promise<Response> {
  const rec = await recordLegacy(deps, minimalSummary(ctx.payload), ctx.eventMode, false, "invalid_signature", null);
  logEvent({ level: "warn", event: rec.throttled ? "invalid_signature_throttled" : "invalid_signature_ill_formed" });
  return ctx.fail("invalid_signature", "Firma inválida.", 401);
}

/** Evento sin destino conocido: firma contra la credencial de plataforma.
 * `ambiguous` = el checkout coincide con mas de una fila legacy: con firma valida
 * NO se paga y queda `legacy_not_applied` (visible en health). */
export async function handleUnknownEvent(deps: Deps, ctx: EventContext, opts: { ambiguous?: boolean } = {}): Promise<Response> {
  const cred = await deps.getPlatformCredential();
  if (!cred) {
    logEvent({ level: "error", event: "platform_credential_unavailable" });
    return ctx.fail("platform_credential_unavailable", "No se puede verificar el evento.", 503);
  }
  const valid = await eventSignatureValid(ctx.payload, cred, ctx.eventMode);
  if (!valid) {
    const rec = await recordLegacy(deps, minimalSummary(ctx.payload), ctx.eventMode, false, "invalid_signature", null);
    if (rec.throttled) logEvent({ level: "warn", event: "invalid_signature_throttled" });
    return ctx.fail("invalid_signature", "Firma inválida.", 401);
  }
  if (opts.ambiguous) {
    const txm = ((ctx.payload.data as Record<string, unknown> | undefined)?.transaction ?? {}) as Record<string, unknown>;
    const rec = await recordLegacy(deps, ctx.payload, ctx.eventMode, true, "legacy_not_applied", null, `ambiguous:${String(txm.payment_link_id ?? "").slice(0, 100)}`);
    logEvent({ level: "critical", event: "legacy_ambiguous_checkout_event", transaction_id: typeof txm.id === "string" ? txm.id.slice(0, 128) : null });
    return ctx.respond({ ok: true, event_id: rec.event_id, classification: rec.classification }, 200);
  }
  const rec = await recordLegacy(deps, minimalSummary(ctx.payload), ctx.eventMode, true, "unknown_link", null);
  return ctx.respond({ ok: true, event_id: rec.event_id, classification: rec.classification }, 200);
}

export async function handleLegacyTarget(deps: Deps, ctx: EventContext, target: LegacyTarget): Promise<Response> {
  const { payload, tx, eventMode } = ctx;

  // (a) firma con el merchant correcto
  let cred: PlatformCredential | null = null;
  try {
    cred = target.merchantTenantId === null ? await deps.getPlatformCredential() : await deps.legacy.getCredential(target.merchantTenantId);
  } catch {
    cred = null;
  }
  if (!cred) {
    logEvent({ level: "critical", event: "merchant_credential_unavailable", origin: target.origin, target_id: target.id, merchant_tenant_id: target.merchantTenantId });
    if (target.merchantTenantId === null) {
      // Credencial de PLATAFORMA: falla de configuracion propia, igual en todos los caminos.
      return ctx.fail("credential_unavailable", "No se puede verificar el evento.", 503);
    }
    // Credencial de TENANT no resoluble: misma respuesta que firma invalida (un 503 aqui
    // revelaria que existe un destino con ese checkout id). El motivo real queda en el log.
    await recordLegacy(deps, minimalSummary(payload), eventMode, false, "invalid_signature", target);
    return ctx.fail("invalid_signature", "Firma inválida.", 401);
  }
  const valid = await eventSignatureValid(payload, cred, eventMode);
  if (!valid) {
    const rec = await recordLegacy(deps, minimalSummary(payload), eventMode, false, "invalid_signature", target);
    logEvent({ level: "warn", event: rec.throttled ? "invalid_signature_throttled" : "invalid_signature", origin: target.origin, target_id: target.id });
    return ctx.fail("invalid_signature", "Firma inválida.", 401);
  }

  const txId = typeof tx.id === "string" && tx.id.length > 0 ? tx.id : null;
  const status = typeof tx.status === "string" && tx.status.length > 0 ? tx.status : null;
  const done = async (classification: string, extra: Record<string, unknown> = {}) => {
    const rec = await recordLegacy(deps, payload, eventMode, true, classification, target);
    return ctx.respond({ ok: true, event_id: rec.event_id, classification: rec.classification, ...extra }, 200);
  };
  const alert = (event: string, extra: Record<string, unknown> = {}) =>
    logEvent({ level: "critical", event, origin: target.origin, target_id: target.id, transaction_id: txId, ...extra });

  if (!txId || !status) {
    alert("legacy_event_without_transaction");
    return await done("verification_mismatch");
  }
  const approved = status === "APPROVED";

  // (d) una transaccion no puede acreditar un segundo destino
  const usage = (await callRpc<UsageRow[] | null>(deps.rpc, "payments_transaction_usage", { p_transaction_id: txId })) ?? [];
  const usedInEvents = usage.some((u) => u.wompi_link_id !== target.wompiLinkId);
  const usedInTables = await deps.legacy.transactionUsedElsewhere(txId, target);
  if (usedInEvents || usedInTables) {
    alert("legacy_transaction_conflict", { used_in_events: usedInEvents, used_in_tables: usedInTables });
    return await done("transaction_conflict");
  }

  // (e) idempotencia: misma transaccion/estado ya aplicada a ESTE destino
  const seenBefore = usage.some((u) => u.wompi_link_id === target.wompiLinkId && u.tx_status === status && APPLIED_CLASSES.has(u.classification));
  if (seenBefore || (approved && target.appliedTransactionId === txId)) return await done("duplicate");

  // (c) monto/moneda contra lo esperado almacenado en el destino
  const amount = tx.amount_in_cents;
  const amountOk = target.expectedCents !== null &&
    typeof amount === "number" && Number.isInteger(amount) && amount === target.expectedCents &&
    typeof target.currency === "string" && tx.currency === target.currency;
  if (!amountOk) {
    alert("legacy_amount_mismatch", { expected_cents: target.expectedCents, event_cents: typeof amount === "number" ? amount : null });
    return await done("amount_mismatch");
  }

  // (b) toda APPROVED se confirma contra Wompi con la llave de ESE merchant
  let applyTx: Record<string, unknown> = tx;
  if (approved) {
    const privateKey = await cred.getSecret("private_key");
    const v = await verifyTransaction(deps, cred.mode, privateKey, txId);
    if (v.retryable || !v.verified) {
      await recordLegacy(deps, payload, eventMode, true, "unverified", target);
      return ctx.fail("verification_unavailable", "No se pudo confirmar la transacción con Wompi; reintenta.", 503);
    }
    const d = v.verified;
    const verifiedOk = d._not_found !== true && d.id === txId && d.status === "APPROVED" &&
      d.payment_link_id === target.wompiLinkId && d.amount_in_cents === amount && d.currency === target.currency;
    if (!verifiedOk) {
      alert("legacy_verification_mismatch");
      return await done("verification_mismatch");
    }
    applyTx = d;
  }

  // Una fila borrada (soft-delete) no es pagable en silencio: cae en legacy_not_applied con alerta.
  const pending = !target.deleted && (target.origin === "invoice" ? ["PENDING", "OVERDUE"].includes(target.status) : target.status === "pending");
  const paidState = target.origin === "invoice" ? "PAID" : "paid";
  const appliedClass = target.origin === "invoice" ? "legacy_invoice" : "legacy_order_payment";

  if (!approved) {
    // Los intentos no aprobados solo se asientan mientras el destino esta pendiente
    // (lo garantiza applyWebhookEvent); un DECLINED/VOIDED posterior a un pago no lo regresa.
    if (pending) await deps.legacy.apply(target, applyTx);
    if (status === "VOIDED" && target.appliedTransactionId === txId) alert("legacy_voided_after_paid");
    return await done(appliedClass);
  }

  if (pending) {
    const r = await deps.legacy.apply(target, applyTx);
    if (r.handled) return await done(appliedClass);
    // Perdio una carrera contra otra entrega del mismo evento (o el estado cambio): se relee.
    const again = await deps.legacy.find(target.wompiLinkId);
    if (again && again !== "ambiguous") {
      if (again.appliedTransactionId === txId) return await done("duplicate");
      if (again.status === paidState) {
        alert("legacy_second_approved_transaction");
        return await done("duplicate_payment");
      }
    }
    alert("legacy_apply_not_handled");
    return await done("legacy_not_applied");
  }
  if (target.status === paidState) {
    // Otra transaccion aprobada sobre un destino ya pagado: candidata a reembolso.
    alert("legacy_second_approved_transaction");
    return await done("duplicate_payment");
  }
  // Cobrado en Wompi pero el destino ya no admite el pago (anulado/reembolsado/vencido).
  alert("legacy_approved_on_closed_target", { target_status: target.status, deleted: target.deleted });
  return await done("legacy_not_applied");
}
