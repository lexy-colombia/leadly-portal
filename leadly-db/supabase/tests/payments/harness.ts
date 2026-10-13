// Arnés de pruebas de payments-api: RPC falso que imita las funciones
// public.payments_* de P1 (contrato §2), Wompi falso y destinos falsos.
// Sin red real: todo pasa por el `fetch` inyectado.
import { createHandler } from "../../functions/_shared/payments-service/router.ts";
import { generateApiKey } from "../../functions/_shared/payments-service/apiKeys.ts";
import { hmacSha256Hex, sha256Hex } from "../../functions/_shared/payments-service/hmac.ts";
import { ApiError } from "../../functions/_shared/payments-service/errors.ts";
import type { Deps, LegacyTarget, PayEnvironment } from "../../functions/_shared/payments-service/types.ts";

export const SUPABASE_URL = "https://proj.supabase.co";
export const SECRETS = {
  privateKey: "prv_test_SECRETPRIVATEKEY123",
  eventsKey: "test_events_SECRETEVENTSKEY456",
  adminJwt: "admin-jwt-SECRETTOKEN",
};

type Row = Record<string, any>;
const pyErr = (code: string, message: string) => ({ data: null, error: { code, message } });
const ok = (data: unknown) => ({ data, error: null });
let seq = 0;

export interface World {
  clients: Row[];
  links: Row[];
  events: Row[];
  deliveries: Row[];
  attempts: Row[];
  vault: Map<string, string>;
  rpcCalls: Array<{ fn: string; args: Record<string, unknown> }>;
  fetchCalls: Array<{ url: string; init: RequestInit }>;
  credential: { mode: PayEnvironment; privateKey: string | null; eventsKey: string | null } | null;
  wompi: { status: number; body: unknown; throws: "abort" | "network" | null; created: number };
  callbacks: Map<string, (init: RequestInit) => Promise<Response> | Response>;
  buggyAmount: boolean;
  /** Origenes legacy simulados (public.payment_invoices / sales_order_payment_links). */
  legacy: {
    targets: Map<string, LegacyTarget>;
    /** key = tenant id o "platform" */
    credentials: Map<string, { mode: PayEnvironment; privateKey: string | null; eventsKey: string | null } | null>;
    /** transaccion -> id del destino que la acredito (para transactionUsedElsewhere) */
    usedTx: Map<string, string>;
    applied: Array<{ targetId: string; txId: string; status: string }>;
    ambiguous: Set<string>;
  };
  /** Wompi GET /transactions/{id}: echo = devuelve la transacción real registrada por wompiEvent(). */
  verify: { mode: "echo" | "notfound" | "unauthorized" | "server_error" | "network" | "timeout" | "override"; override?: Row; calls: string[] };
  healthSummary: Row;
}

/** Transacciones "reales" de Wompi, registradas al construir cada evento. */
export const knownTransactions = new Map<string, Row>();

export function newWorld(): World {
  return {
    clients: [], links: [], events: [], deliveries: [], attempts: [],
    vault: new Map(), rpcCalls: [], fetchCalls: [],
    credential: { mode: "sandbox", privateKey: SECRETS.privateKey, eventsKey: SECRETS.eventsKey },
    wompi: { status: 201, body: null, throws: null, created: 0 },
    callbacks: new Map(), buggyAmount: false,
    legacy: { targets: new Map(), credentials: new Map(), usedTx: new Map(), applied: [], ambiguous: new Set() },
    verify: { mode: "echo", calls: [] }, healthSummary: { invalid_signature: 0, unverified: 0 },
  };
}

function rpcImpl(w: World, fn: string, a: Record<string, any>) {
  const now = new Date().toISOString();
  const link = (id: string) => w.links.find((l) => l.id === id);
  switch (fn) {
    case "payments_lookup_client": {
      const c = w.clients.find((x) => x.api_key_hash === a.p_key_hash && x.status === "active" && !x.revoked_at);
      return ok(c ? { id: c.id, name: c.name, status: c.status, callback_url: c.callback_url, signing_secret_name: c.signing_secret_name } : null);
    }
    case "payments_begin_link": {
      const ex = w.links.find((l) => l.client_id === a.p_client_id && l.idempotency_key === a.p_idempotency_key);
      if (ex) {
        if (ex.request_hash !== a.p_request_hash) return pyErr("PY409", "Idempotency-Key reutilizada con otro cuerpo");
        return ok({ link: ex, replayed: true });
      }
      const r = a.p_request;
      const l: Row = {
        id: crypto.randomUUID(), client_id: a.p_client_id, wompi_link_id: null, external_reference: r.external_reference,
        idempotency_key: a.p_idempotency_key, request_hash: a.p_request_hash, amount_in_cents: r.amount_in_cents,
        currency: r.currency, environment: a.p_environment, name: r.name, description: r.description,
        redirect_url: r.redirect_url, expires_at: r.expires_at, metadata: r.metadata, status: "creating",
        checkout_url: null, paid_transaction_id: null, paid_at: null, created_by: a.p_created_by, created_at: now, updated_at: now,
      };
      w.links.push(l);
      return ok({ link: l, replayed: false });
    }
    case "payments_attach_wompi_link": {
      const l = link(a.p_link_id)!;
      l.wompi_link_id = a.p_wompi_link_id; l.checkout_url = a.p_checkout_url; l.status = "pending";
      return ok(l);
    }
    case "payments_fail_link": {
      const l = link(a.p_link_id)!;
      l.status = "error"; l.status_detail = a.p_detail;
      return ok(l);
    }
    case "payments_get_link": {
      const l = w.links.find((x) =>
        x.client_id === a.p_client_id && (a.p_id ? x.id === a.p_id : x.external_reference === a.p_external_reference)
      );
      if (!l) return pyErr("PY404", "no existe");
      const last = [...w.events].reverse().find((e) => e.link_id === l.id);
      return ok({ ...l, last_event: last ? { id: last.id, classification: last.classification, tx_status: last.tx_status, transaction_id: last.transaction_id, amount_in_cents: last.amount_in_cents, received_at: last.received_at, raw: last.raw } : null });
    }
    case "payments_list_links": {
      let items = w.links.filter((l) => (!a.p_client_id || l.client_id === a.p_client_id) && (!a.p_status || l.status === a.p_status));
      items = items.slice(0, a.p_limit);
      return ok({ items, next_before: null });
    }
    case "payments_public_link_status": {
      const l = link(a.p_id);
      const lastEv = [...w.events].reverse().find((e) =>
        (e.link_id === a.p_id || e.origin_ref === a.p_id) &&
        ["APPROVED", "DECLINED", "VOIDED", "ERROR"].includes(e.tx_status) &&
        ["processed", "duplicate_payment", "legacy_invoice", "legacy_order_payment"].includes(e.classification)
      );
      return ok({ found: !!l, status: l?.status ?? null, last_attempt: lastEv?.tx_status ?? null, updated_at: l?.updated_at ?? null });
    }
    case "payments_find_link_by_wompi_id": {
      const l = w.links.find((x) => x.wompi_link_id === a.p_wompi_link_id);
      return ok(l ? { id: l.id, client_id: l.client_id, environment: l.environment, status: l.status, amount_in_cents: l.amount_in_cents, currency: l.currency } : null);
    }
    case "payments_record_event": {
      const p = a.p_payload;
      const tx = p?.data?.transaction;
      const ev: Row = {
        id: ++seq, received_at: now, environment: a.p_environment, raw: p, signature_valid: a.p_signature_valid,
        transaction_id: tx?.id ?? null, tx_status: tx?.status ?? null, amount_in_cents: tx?.amount_in_cents ?? null,
        wompi_link_id: tx?.payment_link_id ?? null, link_id: null,
      };
      w.events.push(ev);
      if (p?._malformed) { ev.classification = "malformed"; return ok({ event_id: ev.id, classification: "malformed", link_id: null, client_id: null, link_status: null, deliveries: [] }); }
      ev.verified = a.p_verified ?? null;
      const l = w.links.find((x) => x.wompi_link_id === ev.wompi_link_id);
      if (a.p_signature_valid === false) { ev.link_id = l?.id ?? null; ev.classification = "invalid_signature"; return ok({ event_id: ev.id, classification: "invalid_signature", link_id: l?.id ?? null, client_id: l?.client_id ?? null, link_status: l?.status ?? null, deliveries: [] }); }
      if (!l) { ev.classification = "unknown_link"; return ok({ event_id: ev.id, classification: "unknown_link", link_id: null, client_id: null, link_status: null, deliveries: [] }); }
      ev.link_id = l.id;
      let cls = "processed";
      const pv = a.p_verified as Row | null;
      const verifyFail = tx.status === "APPROVED" && pv && (pv._not_found || pv.payment_link_id !== tx.payment_link_id || pv.status !== tx.status || Number(pv.amount_in_cents) !== Number(tx.amount_in_cents) || pv.currency !== tx.currency);
      const conflict = w.events.some((e) => e !== ev && e.transaction_id === ev.transaction_id && e.wompi_link_id !== ev.wompi_link_id && ["processed", "duplicate_payment", "amount_mismatch", "legacy_invoice", "legacy_order_payment"].includes(e.classification));
      const mismatch = !w.buggyAmount && (Number(tx.amount_in_cents) !== Number(l.amount_in_cents) || tx.currency !== l.currency);
      const dup = w.events.some((e) => e !== ev && e.transaction_id === ev.transaction_id && e.tx_status === ev.tx_status && ["processed", "duplicate_payment"].includes(e.classification));
      if (tx.status === "APPROVED" && pv === null) cls = "unverified";
      else if (verifyFail) cls = "verification_mismatch";
      else if (tx.status === "APPROVED" && conflict) cls = "transaction_conflict";
      else if (dup) cls = "duplicate";
      else if (mismatch) cls = "amount_mismatch";
      else if (tx.status === "APPROVED") {
        if (l.status === "paid") cls = "duplicate_payment";
        else { l.status = "paid"; l.paid_transaction_id = tx.id; l.paid_at = now; }
      }
      ev.classification = cls;
      if (["unverified", "verification_mismatch", "transaction_conflict"].includes(cls)) {
        return ok({ event_id: ev.id, classification: cls, link_id: l.id, client_id: l.client_id, link_status: l.status, deliveries: [] });
      }
      if (tx.status === "VOIDED" && l.paid_transaction_id === tx.id) l.status = "voided";
      const c = w.clients.find((x) => x.id === l.client_id)!;
      const deliveries: Array<{ id: string; url: string }> = [];
      if (cls !== "duplicate" && c.callback_url) {
        const d: Row = {
          id: crypto.randomUUID(), event_id: ev.id, client_id: c.id, link_id: l.id, url: c.callback_url, attempt: 0,
          status: "pending", next_attempt_at: now,
          body: {
            id: String(ev.id), type: "payment_link.transaction", created_at: now,
            transaction: { id: tx.id, status: tx.status, amount_in_cents: tx.amount_in_cents, currency: tx.currency },
            payment_link: { id: l.id, external_reference: l.external_reference, status: l.status, amount_in_cents: l.amount_in_cents, currency: l.currency, metadata: l.metadata },
            classification: cls, wompi: p,
          },
        };
        w.deliveries.push(d);
        deliveries.push({ id: d.id, url: d.url });
      }
      return ok({ event_id: ev.id, classification: cls, link_id: l.id, client_id: l.client_id, link_status: l.status, deliveries });
    }
    case "payments_record_legacy_event": {
      const p = a.p_payload;
      const tx = p?.data?.transaction;
      const ev: Row = {
        id: ++seq, received_at: now, environment: a.p_environment, raw: p, signature_valid: a.p_signature_valid,
        transaction_id: tx?.id ?? null, tx_status: tx?.status ?? null, amount_in_cents: tx?.amount_in_cents ?? null,
        wompi_link_id: tx?.payment_link_id ?? null, link_id: null, classification: a.p_classification,
        origin: a.p_origin, origin_ref: a.p_origin_ref, expected_cents: a.p_expected_cents,
      };
      w.events.push(ev);
      return ok({ event_id: ev.id, classification: ev.classification });
    }
    case "payments_transaction_usage": {
      const used = ["processed", "duplicate_payment", "amount_mismatch", "forwarded_foreign", "legacy_invoice", "legacy_order_payment"];
      return ok(w.events.filter((e) => e.transaction_id === a.p_transaction_id && used.includes(e.classification)).map((e) => ({
        wompi_link_id: e.wompi_link_id, tx_status: e.tx_status, classification: e.classification, origin: e.origin ?? null, origin_ref: e.origin_ref ?? null,
      })));
    }
    case "payments_claim_deliveries": {
      const due = w.deliveries.filter((d) => d.status === "pending" && !d.leased && w.clients.find((c) => c.id === d.client_id)?.status === "active").slice(0, a.p_limit);
      due.forEach((d) => { d.leased = true; d.attempt += 1; });
      return ok(due.map((d) => {
        const c = w.clients.find((x) => x.id === d.client_id)!;
        return { delivery_id: d.id, url: d.url, client_id: d.client_id, signing_secret_name: c.signing_secret_name, body: d.body, attempt: d.attempt };
      }));
    }
    case "payments_complete_delivery": {
      const d = w.deliveries.find((x) => x.id === a.p_delivery_id)!;
      d.leased = false;
      w.attempts.push({ delivery_id: d.id, attempt: d.attempt, http_status: a.p_http_status, error: a.p_error, sent_sha256: a.p_sent_sha256 ?? null });
      if (a.p_http_status >= 200 && a.p_http_status < 300) d.status = "delivered";
      else if (d.attempt >= 7) d.status = "failed";
      d.last_error = a.p_error;
      return ok({ status: d.status });
    }
    case "payments_read_secret": return ok(w.vault.get(a.p_name) ?? null);
    case "payments_store_secret": w.vault.set(a.p_name, a.p_value); return ok(null);
    case "payments_read_signing_secret_name": return ok(w.clients.find((c) => c.id === a.p_client_id)?.signing_secret_name ?? null);
    case "payments_admin_create_client": {
      if (w.clients.some((c) => c.name === a.p_name)) return pyErr("PY409", "nombre en uso");
      const c: Row = {
        id: crypto.randomUUID(), name: a.p_name, status: "active", api_key_hash: a.p_key_hash, key_prefix: a.p_key_prefix,
        callback_url: a.p_callback_url, signing_secret_name: a.p_signing_secret_name, created_at: now, updated_at: now, revoked_at: null,
      };
      w.clients.push(c);
      return ok(c);
    }
    case "payments_admin_list_clients": return ok(w.clients);
    case "payments_admin_set_client_status": { const c = w.clients.find((x) => x.id === a.p_id); if (!c) return pyErr("PY404", "x"); c.status = a.p_status; return ok(c); }
    case "payments_admin_rotate_key": { const c = w.clients.find((x) => x.id === a.p_id); if (!c) return pyErr("PY404", "x"); c.api_key_hash = a.p_key_hash; c.key_prefix = a.p_key_prefix; return ok(c); }
    case "payments_admin_set_callback": { const c = w.clients.find((x) => x.id === a.p_id); if (!c) return pyErr("PY404", "x"); c.callback_url = a.p_callback_url; c.signing_secret_name = a.p_signing_secret_name; return ok(c); }
    case "payments_health_summary": return ok(w.healthSummary);
    case "payments_redact_events": return ok({ redacted: 0 });
    default: throw new Error(`rpc no simulado: ${fn}`);
  }
}

export function makeDeps(w: World, over: Partial<Deps> = {}): Deps {
  const fakeFetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = String(input);
    w.fetchCalls.push({ url, init });
    if (url === "https://sandbox.wompi.co/v1/payment_links" || url === "https://production.wompi.co/v1/payment_links") {
      if (w.wompi.throws === "abort") {
        await new Promise((_, rej) => init.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))));
      }
      if (w.wompi.throws === "network") throw new TypeError("connection reset");
      w.wompi.created++;
      const body = w.wompi.body ?? { data: { id: `wl_${w.wompi.created}_abc` } };
      return new Response(JSON.stringify(body), { status: w.wompi.status });
    }
    const txm = url.match(/^https:\/\/(sandbox|production)\.wompi\.co\/v1\/transactions\/(.+)$/);
    if (txm) {
      const id = decodeURIComponent(txm[2]);
      w.verify.calls.push(id);
      const auth = (init.headers as Record<string, string> | undefined)?.Authorization;
      if (auth !== `Bearer ${SECRETS.privateKey}` && auth !== `Bearer ${TENANT_KEYS.privateKey}`) return new Response("{}", { status: 401 });
      switch (w.verify.mode) {
        case "network": throw new TypeError("connection reset");
        case "timeout":
          await new Promise((_, rej) => init.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))));
          break;
        case "notfound": return new Response("{}", { status: 404 });
        case "unauthorized": return new Response("{}", { status: 401 });
        case "server_error": return new Response("{}", { status: 502 });
        case "override": return new Response(JSON.stringify({ data: w.verify.override }), { status: 200 });
      }
      const real = knownTransactions.get(id);
      if (!real) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify({ data: real }), { status: 200 });
    }
    const cb = w.callbacks.get(url);
    if (cb) {
      const r = cb(init);
      if (r instanceof Response) return r;
      return await r;
    }
    return new Response("not found", { status: 404 });
  };
  return {
    rpc: {
      rpc(fn: string, args: Record<string, unknown> = {}) {
        w.rpcCalls.push({ fn, args });
        return Promise.resolve(rpcImpl(w, fn, args));
      },
    },
    fetch: fakeFetch as typeof fetch,
    now: () => Date.now(),
    getPlatformCredential: async () => {
      const c = w.credential;
      if (!c) return null;
      return {
        mode: c.mode,
        getSecret: async (n: string) => (n === "private_key" ? c.privateKey : n === "events_key" ? c.eventsKey : null),
      };
    },
    verifyAdmin: async (h) => {
      if (!h) throw new ApiError(401, "unauthorized", "Falta la sesión.");
      if (h === `Bearer ${SECRETS.adminJwt}`) return { userId: "11111111-1111-4111-8111-111111111111" };
      if (h === "Bearer agent-jwt") throw new ApiError(403, "forbidden", "Solo un superadministrador.");
      throw new ApiError(401, "unauthorized", "Sesión inválida.");
    },
    env: { supabaseUrl: SUPABASE_URL, cronSecret: "cron-secret-VALUE-1234" },
    legacy: {
      find: async (id) => {
        if (w.legacy.ambiguous.has(id)) return "ambiguous";
        const t = w.legacy.targets.get(id);
        return t ? { ...t } : null;
      },
      publicStatus: async (id) => {
        for (const t of w.legacy.targets.values()) {
          if (t.id !== id) continue;
          if (t.deleted) return null;
          const inv: Record<string, string> = { PENDING: "pending", OVERDUE: "pending", PAID: "paid", CANCELLED: "cancelled", REFUNDED: "voided" };
          const status = (t.origin === "invoice" ? inv[t.status] : t.status) as never;
          return { status: status ?? "unknown", updatedAt: "2026-10-11T12:00:00.000Z" };
        }
        return null;
      },
      getCredential: async (tenantId) => {
        const c = w.legacy.credentials.get(tenantId ?? "platform");
        if (!c) return null;
        return { mode: c.mode, getSecret: async (n: string) => (n === "private_key" ? c.privateKey : n === "events_key" ? c.eventsKey : null) };
      },
      transactionUsedElsewhere: async (txId, target) => {
        const by = w.legacy.usedTx.get(txId);
        return by !== undefined && by !== target.id;
      },
      apply: async (target, tx) => {
        const t = w.legacy.targets.get(target.wompiLinkId)!;
        const approved = tx.status === "APPROVED";
        const pend = t.origin === "invoice" ? ["PENDING", "OVERDUE"].includes(t.status) : t.status === "pending";
        if (!pend) return { handled: false };
        if (t.origin === "order_link" && !approved) return { handled: false };
        w.legacy.applied.push({ targetId: t.id, txId: String(tx.id), status: String(tx.status) });
        if (approved) {
          t.status = t.origin === "invoice" ? "PAID" : "paid";
          t.appliedTransactionId = String(tx.id);
          w.legacy.usedTx.set(String(tx.id), t.id);
        }
        return { handled: true };
      },
    },
    timeouts: { deliveryMs: 60, wompiMs: 60, verifyMs: 60 },
    ...over,
  };
}

export async function addClient(w: World, o: { name?: string; callback?: string | null; env?: PayEnvironment; secret?: string } = {}) {
  const key = await generateApiKey(o.env ?? "sandbox");
  const secretName = `payments/${crypto.randomUUID()}/signing`;
  const signing = o.secret ?? "lxy_whsec_TESTSIGNINGSECRET";
  w.vault.set(secretName, signing);
  const c: Row = {
    id: crypto.randomUUID(), name: o.name ?? `proj-${w.clients.length}`, status: "active", api_key_hash: key.keyHash,
    key_prefix: key.keyPrefix, callback_url: o.callback === undefined ? "https://hooks.example.com/pay" : o.callback,
    signing_secret_name: secretName, created_at: new Date().toISOString(), revoked_at: null,
  };
  w.clients.push(c);
  return { client: c, apiKey: key.apiKey, signingSecret: signing };
}

export function handler(w: World, over: Partial<Deps> = {}) {
  return createHandler(makeDeps(w, over));
}

export function req(method: string, path: string, o: { key?: string; headers?: Record<string, string>; body?: unknown; raw?: string } = {}) {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.key) headers.authorization = `Bearer ${o.key}`;
  let body: string | undefined;
  if (o.raw !== undefined) body = o.raw;
  else if (o.body !== undefined) { body = JSON.stringify(o.body); headers["content-type"] = "application/json"; }
  return new Request(`${SUPABASE_URL}/functions/v1/payments-api${path}`, { method, headers, body });
}

export const validLink = (over: Record<string, unknown> = {}) => ({
  amount_in_cents: 1_500_000, currency: "COP", name: "Plan Pro", description: "Plan Pro octubre",
  external_reference: "inv-001", redirect_url: "https://leadly.example.com/thanks", metadata: { order: 7 }, ...over,
});

export async function wompiEvent(o: {
  linkId: string; txId?: string; status?: string; amount?: number; currency?: string; env?: "test" | "prod"; eventsKey?: string;
}) {
  const data = {
    transaction: {
      id: o.txId ?? "tx-1", status: o.status ?? "APPROVED", amount_in_cents: o.amount ?? 1_500_000, currency: o.currency ?? "COP",
      reference: "auto", customer_email: "persona@example.com", payment_method_type: "CARD", payment_link_id: o.linkId,
    },
  };
  // La transacción real (la que Wompi devolvería en GET /transactions/{id}).
  if (!knownTransactions.has(data.transaction.id) || o.linkId !== "ajeno") {
    knownTransactions.set(data.transaction.id, {
      id: data.transaction.id, status: data.transaction.status, amount_in_cents: data.transaction.amount_in_cents,
      currency: data.transaction.currency, payment_link_id: o.linkId, reference: "auto",
    });
  }
  const timestamp = 1_760_000_000;
  const props = ["transaction.id", "transaction.status", "transaction.amount_in_cents"];
  const checksum = await sha256Hex(`${data.transaction.id}${data.transaction.status}${data.transaction.amount_in_cents}${timestamp}${o.eventsKey ?? SECRETS.eventsKey}`);
  return { event: "transaction.updated", data, environment: o.env ?? "test", signature: { properties: props, checksum }, timestamp, sent_at: "2026-10-10T12:00:00.000Z" };
}

/** Registra un destino legacy y la credencial de su merchant. */
export function addLegacyTarget(
  w: World,
  o: { origin: "invoice" | "order_link"; wompiLinkId: string; merchantTenantId?: string | null; expectedCents?: number | null; currency?: string; status?: string; deleted?: boolean },
) {
  const t: LegacyTarget = {
    origin: o.origin,
    id: crypto.randomUUID(),
    wompiLinkId: o.wompiLinkId,
    merchantTenantId: o.merchantTenantId === undefined ? (o.origin === "invoice" ? null : crypto.randomUUID()) : o.merchantTenantId,
    status: o.status ?? (o.origin === "invoice" ? "PENDING" : "pending"),
    expectedCents: o.expectedCents === undefined ? 1_500_000 : o.expectedCents,
    currency: o.currency ?? "COP",
    deleted: o.deleted ?? false,
    appliedTransactionId: null,
  };
  w.legacy.targets.set(o.wompiLinkId, t);
  const key = t.merchantTenantId ?? "platform";
  if (!w.legacy.credentials.has(key)) {
    // Credenciales distintas por merchant (el evento de un tenant NO se firma con la llave de plataforma)
    w.legacy.credentials.set(key, t.merchantTenantId === null
      ? { mode: "sandbox", privateKey: SECRETS.privateKey, eventsKey: SECRETS.eventsKey }
      : { mode: "sandbox", privateKey: TENANT_KEYS.privateKey, eventsKey: TENANT_KEYS.eventsKey });
  }
  return t;
}
export const TENANT_KEYS = { privateKey: "prv_test_TENANTPRIVATE777", eventsKey: "test_events_TENANTEVENTS555" };

export async function createOwnLink(w: World, h: (r: Request) => Promise<Response>, apiKey: string, over: Record<string, unknown> = {}, idem = crypto.randomUUID()) {
  const res = await h(req("POST", "/v1/payment-links", { key: apiKey, headers: { "idempotency-key": idem }, body: validLink(over) }));
  const body = await res.json();
  return { res, body, wompiLinkId: w.links.find((l) => l.id === body.id)?.wompi_link_id as string };
}

/** Captura console.* durante una función y devuelve lo escrito. */
export async function captureLogs<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string }> {
  const lines: string[] = [];
  const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug };
  const sink = (...a: unknown[]) => { lines.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); };
  console.log = sink; console.error = sink; console.warn = sink; console.info = sink; console.debug = sink;
  try {
    return { result: await fn(), logs: lines.join("\n") };
  } finally {
    Object.assign(console, orig);
  }
}

export { hmacSha256Hex };
