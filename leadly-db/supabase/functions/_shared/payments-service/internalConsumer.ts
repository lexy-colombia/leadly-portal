// Consumidor interno de Leadly del aviso firmado de payments-api (el mismo sobre
// que reciben Lexy Legal / Bedly; ver payments-api/README.md §2-§5).
//
// Contrato de vinculo (lo fija quien CREA el link, ST4):
//   payment_link.external_reference = 'order:<sales_orders.id>' | 'invoice:<payment_invoices.id>'
//   payment_link.metadata = { kind: 'order'|'invoice', tenant_id, order_id | invoice_id }
// El sobre debe ser coherente (referencia == metadata) y el destino debe pertenecer
// al tenant declarado: la escritura y esa comprobacion ocurren en UNA transaccion SQL
// (public.apply_wompi_order_payment / apply_wompi_invoice_payment).
//
// Reglas:
//  * firma/tolerancia invalida -> 401 sin detalle (nada se parsea antes de verificar);
//  * solo se acredita con classification=processed + payment_link.status=paid +
//    transaction.status=APPROVED; el resto -> 200 sin efecto (voided / duplicate_payment /
//    amount_mismatch dejan log critical, sin reversion automatica);
//  * problemas del SOBRE o del DESTINO (incoherente, tenant ajeno, monto, conflicto) -> 200
//    con log critical (reintentar no los arregla); fallos transitorios (Vault/DB) -> 5xx
//    para que el servicio reintente (1m, 5m, 30m, 2h, 6h, 24h).
//  * Deduplicacion: sin tabla de eventos; la dan los indices unicos de la base y el estado
//    del destino (una reentrega del mismo evento devuelve 'duplicate').
import { jsonResponse, logEvent, newRequestId } from "./errors.ts";
import { verifyEnvelopeSignature } from "./hmac.ts";
import type { RpcClient } from "./types.ts";

export interface InternalConsumerDeps {
  rpc: RpcClient;
  now: () => number;
  /** payments.clients.id del cliente interno de Leadly (secreto de funcion PAYMENTS_INTERNAL_CLIENT_ID). */
  clientId: string | null;
}

const MAX_BODY_BYTES = 256 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REF = /^(order|invoice):([0-9a-f-]{36})$/i;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

/** Detalle de la transaccion de Wompi (mismos campos que wompi.ts::extractPaymentDetails). */
export function extractPaymentDetails(tx: Obj): { method: string; brand: string | null; last_four: string | null; bank: string | null; reference: string } {
  const method = isObj(tx.payment_method) ? tx.payment_method : {};
  const extra = isObj(method.extra) ? method.extra : {};
  const type = typeof tx.payment_method_type === "string" && tx.payment_method_type ? tx.payment_method_type : (typeof method.type === "string" ? method.type : "");
  let brand: string | null = null;
  let lastFour: string | null = null;
  let bank: string | null = null;
  let reference: string;
  switch (type) {
    case "CARD":
      brand = (typeof extra.brand === "string" ? extra.brand : "").toUpperCase() || null;
      lastFour = typeof extra.last_four === "string" ? extra.last_four : null;
      reference = [brand, lastFour ? `****${lastFour}` : null].filter(Boolean).join(" ") || "Tarjeta";
      break;
    case "PSE":
      bank = typeof extra.bank_name === "string" ? extra.bank_name : (typeof method.financial_institution_code === "string" ? method.financial_institution_code : null);
      reference = `PSE${bank ? ` - ${bank}` : ""}`;
      break;
    case "NEQUI":
      reference = `Nequi${typeof method.phone_number === "string" ? ` ${method.phone_number}` : ""}`;
      break;
    case "BANCOLOMBIA_TRANSFER":
      reference = "Bancolombia Transfer";
      break;
    case "BANCOLOMBIA_COLLECT":
      reference = "Bancolombia";
      break;
    default:
      reference = type || "Pago";
  }
  return { method: type, brand, last_four: lastFour, bank, reference };
}

export function createInternalHandler(deps: InternalConsumerDeps): (req: Request) => Promise<Response> {
  return async (req) => {
    const requestId = newRequestId();
    const reply = (status: number, body: unknown) => jsonResponse(body, status, requestId);
    const unauthorized = () => reply(401, { error: { code: "invalid_signature" } });

    if (req.method !== "POST") return reply(405, { error: { code: "method_not_allowed" } });
    if (!deps.clientId || !UUID.test(deps.clientId)) {
      logEvent({ level: "critical", event: "payments_internal_not_configured", request_id: requestId });
      return reply(503, { error: { code: "not_configured" } });
    }

    const rawBody = await req.text();
    if (rawBody.length > MAX_BODY_BYTES) return reply(413, { error: { code: "payload_too_large" } });
    const header = req.headers.get("Payments-Signature");
    // Antes de tocar Vault: una cabecera que ni siquiera tiene la forma t=...,v1=<64 hex> no cuesta lecturas.
    if (!header || !/(^|,)\s*t=\d{1,12}\s*(,|$)/.test(header) || !/(^|,)\s*v1=[0-9a-fA-F]{64}\s*(,|$)/.test(header)) return unauthorized();

    let secret: string | null = null;
    try {
      // El cliente configurado debe ser interno, activo y no revocado ANTES de usar su secreto.
      const ok = await deps.rpc.rpc("payments_internal_client_ok", { p_client_id: deps.clientId });
      if (ok.error || ok.data !== true) {
        logEvent({ level: "critical", event: "payments_internal_client_invalid", request_id: requestId });
        return reply(503, { error: { code: "not_configured" } });
      }
      const name = await deps.rpc.rpc("payments_read_signing_secret_name", { p_client_id: deps.clientId });
      if (name.error || typeof name.data !== "string") throw new Error(name.error?.code ?? "no_secret_name");
      const sec = await deps.rpc.rpc("payments_read_secret", { p_name: name.data });
      if (sec.error || typeof sec.data !== "string" || !sec.data) throw new Error(sec.error?.code ?? "no_secret");
      secret = sec.data;
    } catch (e) {
      // Config/Vault: transitorio o de despliegue. 5xx para que el servicio reintente.
      logEvent({ level: "critical", event: "payments_internal_secret_unavailable", request_id: requestId, reason: e instanceof Error ? e.message : "error" });
      return reply(503, { error: { code: "secret_unavailable" } });
    }

    const valid = await verifyEnvelopeSignature(secret, header, rawBody, Math.floor(deps.now() / 1000));
    if (!valid) {
      logEvent({ level: "warn", event: "payments_internal_invalid_signature", request_id: requestId });
      return unauthorized();
    }

    // A partir de aqui el sobre es autentico (lo firmo el servicio).
    let env: unknown;
    try {
      env = JSON.parse(rawBody);
    } catch {
      logEvent({ level: "critical", event: "payments_internal_malformed_body", request_id: requestId });
      return reply(200, { result: "not_applicable", reason: "malformed_body" });
    }
    if (!isObj(env)) return reply(200, { result: "not_applicable", reason: "malformed_body" });
    const eventId = typeof env.id === "string" ? env.id : null;
    const link = isObj(env.payment_link) ? env.payment_link : null;
    const tx = isObj(env.transaction) ? env.transaction : null;
    const base = { request_id: requestId, event_id: eventId, link_id: typeof link?.id === "string" ? link.id : null, transaction_id: typeof tx?.id === "string" ? tx.id : null };
    const critical = (event: string, extra: Obj = {}) => logEvent({ level: "critical", event, ...base, ...extra });

    if (env.type !== "payment_link.transaction" || !link || !tx) return reply(200, { result: "ignored" });

    const applicable = env.classification === "processed" && link.status === "paid" && tx.status === "APPROVED";
    if (!applicable) {
      if (link.status === "voided") critical("payments_internal_voided", { external_reference: link.external_reference });
      else if (env.classification === "duplicate_payment") critical("payments_internal_duplicate_payment", { external_reference: link.external_reference });
      else if (env.classification === "amount_mismatch") critical("payments_internal_amount_mismatch_event", { external_reference: link.external_reference });
      return reply(200, { result: "ignored" });
    }

    // ---- coherencia del vinculo (D5)
    const ref = typeof link.external_reference === "string" ? REF.exec(link.external_reference) : null;
    const meta = isObj(link.metadata) ? link.metadata : null;
    const kind = ref ? ref[1].toLowerCase() : null;
    const targetId = ref ? ref[2] : null;
    const metaTarget = meta ? (kind === "order" ? meta.order_id : meta.invoice_id) : null;
    const coherent = !!ref && !!meta && isUuid(targetId) && meta.kind === kind && isUuid(meta.tenant_id) && isUuid(metaTarget) &&
      String(metaTarget).toLowerCase() === targetId!.toLowerCase() && isUuid(link.id);
    if (!coherent) {
      critical("payments_internal_inconsistent_envelope", { external_reference: link.external_reference });
      return reply(200, { result: "not_applicable", reason: "inconsistent_envelope" });
    }
    const txId = typeof tx.id === "string" && tx.id ? tx.id : null;
    const linkCents = link.amount_in_cents;
    const txCents = tx.amount_in_cents;
    if (!txId || !Number.isSafeInteger(linkCents) || !Number.isSafeInteger(txCents) || (linkCents as number) <= 0 ||
        typeof link.currency !== "string" || typeof tx.currency !== "string") {
      critical("payments_internal_inconsistent_envelope", { reason: "amount_fields" });
      return reply(200, { result: "not_applicable", reason: "inconsistent_envelope" });
    }
    if (txCents !== linkCents || tx.currency !== link.currency) {
      critical("payments_internal_amount_mismatch", { link_cents: linkCents, tx_cents: txCents });
      return reply(200, { result: "not_applicable", reason: "amount_mismatch" });
    }

    // ---- escritura atomica
    const wompiTx = isObj(env.wompi) && isObj(env.wompi.data) && isObj((env.wompi.data as Obj).transaction) ? (env.wompi.data as Obj).transaction as Obj : null;
    const details = extractPaymentDetails(wompiTx ?? tx);
    let call;
    if (kind === "order") {
      call = await deps.rpc.rpc("apply_wompi_order_payment", {
        p_order_id: targetId,
        p_tenant_id: meta!.tenant_id,
        p_payment_link_id: link.id,
        p_transaction_id: txId,
        p_amount_cents: txCents,
        p_link_amount_cents: linkCents,
        p_currency: tx.currency,
        p_reference: details.reference,
      });
    } else {
      const raw = wompiTx && JSON.stringify(wompiTx).length <= 20000 ? wompiTx : null;
      call = await deps.rpc.rpc("apply_wompi_invoice_payment", {
        p_invoice_id: targetId,
        p_tenant_id: meta!.tenant_id,
        p_transaction_id: txId,
        p_amount_cents: txCents,
        p_link_amount_cents: linkCents,
        p_currency: tx.currency,
        p_payment: { ...details, raw },
      });
    }
    if (call.error || !isObj(call.data) || typeof call.data.result !== "string") {
      // Transitorio (DB): el servicio reintenta. Sin mensaje crudo en la respuesta.
      critical("payments_internal_apply_failed", { code: call.error?.code ?? null, kind });
      return reply(500, { error: { code: "apply_failed" } });
    }
    const out = call.data as Obj;
    const reason = typeof out.reason === "string" ? out.reason : null;
    switch (out.result) {
      case "applied":
        logEvent({ level: "info", event: "payments_internal_applied", ...base, kind });
        break;
      case "duplicate":
        logEvent({ level: "info", event: "payments_internal_duplicate", ...base, kind });
        break;
      case "conflict":
        critical("payments_internal_conflict", { kind, reason });
        break;
      case "not_applicable":
        critical(reason === "tenant_mismatch" ? "payments_internal_tenant_mismatch" : "payments_internal_not_applicable", { kind, reason });
        break;
      default:
        critical("payments_internal_unexpected_result", { kind });
        return reply(500, { error: { code: "apply_failed" } });
    }
    return reply(200, { result: out.result, ...(reason ? { reason } : {}) });
  };
}
