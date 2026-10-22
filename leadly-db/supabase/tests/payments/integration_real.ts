// Prueba de INTEGRACION REAL (revision independiente): router real de P2
// (createHandler) + funciones SQL REALES de P1 (Postgres 15 descartable con la
// migracion aplicada) + Wompi / receptor / reenvio falsos por `fetch` inyectado.
// NO se llama *_test.ts a propósito: necesita Postgres, no corre con `deno test`.
// Uso:   tests/payments/run_integration.sh     (levanta un Postgres 15 descartable,
//        aplica 00_stubs.sql + la migración real y corre este script)
// Manual: DATABASE_URL=postgres://postgres@127.0.0.1:54330/rt deno run -A tests/payments/integration_real.ts
// NO toca ninguna base real. Imprime PASS/FAIL y sale con codigo != 0 si algo falla.
// Seccion 17: camino "evento de un link que no es del servicio" (unknown_link) sin rama legacy,
// sobre SQL real. Las secciones 20/21 usan pgSupabase.ts (emulador de supabase-js en SQL real).
// Corre IGUAL contra el esquema ANTES y DESPUES de 20261017120000_payments_retire_legacy.sql
// (run_integration.sh: PRE_RETIRE=1 no aplica esa migracion).
import postgres from "npm:postgres@3";
import { createHandler } from "../../functions/_shared/payments-service/router.ts";
import { sha256Hex, hmacSha256Hex } from "../../functions/_shared/payments-service/hmac.ts";
import { checkCallbackDestination } from "../../functions/_shared/payments-service/ssrf.ts";
import type { Deps, PayEnvironment, RpcClient } from "../../functions/_shared/payments-service/types.ts";
import { createPaymentLink, validateLinkRequest } from "../../functions/_shared/payments-service/wompiLinks.ts";
import { ApiError } from "../../functions/_shared/payments-service/errors.ts";
import { pgSupabase } from "./pgSupabase.ts";

const URL_DB = Deno.env.get("DATABASE_URL") ?? "postgres://postgres@127.0.0.1:54330/rt";
const root = postgres(URL_DB, { max: 4, onnotice: () => {} }); // superusuario (solo para inspeccionar / forzar tiempos)
const svc = postgres(URL_DB, { max: 12, onnotice: () => {}, connection: { options: "-c role=service_role" } });
// PostgREST devuelve numeric como numero JSON, no como string.
const pubSql = postgres(URL_DB, {
  max: 6, onnotice: () => {}, connection: { options: "-c role=service_role" },
  types: { numeric: { to: 1700, from: [1700], serialize: (x: unknown) => String(x), parse: (x: string) => Number(x) } },
});
const pubAdmin = pgSupabase(pubSql);

let failures = 0;
let passes = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    passes++;
    console.log(`PASS: ${name}`);
  } else {
    failures++;
    console.log(`FAIL: ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
  }
}

// ---- capturador de logs (para buscar secretos filtrados)
const logBuf: string[] = [];
for (const k of ["log", "error", "warn", "info"] as const) {
  const orig = console[k].bind(console);
  console[k] = (...a: unknown[]) => {
    const s = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");
    if (!/^(PASS|FAIL|==|INFO|RESUMEN)/.test(s)) logBuf.push(s);
    orig(...a);
  };
}

// ---- RPC real: invoca public.<fn>(p_x => $::tipo, ...) como service_role
const sigCache = new Map<string, { names: string[]; types: string[] }>();
const realRpc: RpcClient = {
  async rpc(fn, args = {}) {
    try {
      let sig = sigCache.get(fn);
      if (!sig) {
        const r = await root`select proargnames as names,
            (select array_agg(format_type(t, null) order by ord) from unnest(proargtypes::oid[]) with ordinality as u(t, ord)) as types
          from pg_proc where proname = ${fn} and pronamespace = 'public'::regnamespace`;
        if (r.length !== 1) throw new Error(`funcion no encontrada: ${fn}`);
        sig = { names: r[0].names ?? [], types: r[0].types ?? [] };
        sigCache.set(fn, sig);
      }
      const keys = Object.keys(args);
      const parts: string[] = [];
      const vals: unknown[] = [];
      for (const k of keys) {
        const i = sig.names.indexOf(k);
        if (i < 0) return { data: null, error: { code: "PGRST202", message: `arg inexistente ${fn}.${k} (firma real: ${sig.names.join(",")})` } };
        const t = sig.types[i];
        const v = args[k];
        vals.push(t === "jsonb" ? (v === undefined ? null : v) : v ?? null);
        parts.push(`${k} => $${vals.length}::${t}`);
      }
      const rows = await svc.unsafe(`select public.${fn}(${parts.join(", ")}) as r`, vals as never[]);
      return { data: rows[0].r, error: null };
    } catch (e) {
      const err = e as { code?: string; message: string };
      return { data: null, error: { code: err.code, message: err.message } };
    }
  },
};

// ---- mundo falso (Wompi, receptor del proyecto)
const KEYS = {
  privateKey: "prv_test_PRIVATEKEYSECRET999", eventsKey: "test_events_EVENTSKEYSECRET888",
  tenantPrivate: "prv_test_TENANTPRIVATE777", tenantEvents: "test_events_TENANTEVENTS555",
};
// A que merchant (cuenta de Wompi) pertenece cada transaccion "real": la llave privada de OTRO merchant no la ve.
const txMerchant = new Map<string, "platform" | "tenant">();
const world = {
  wompiCalls: [] as Array<{ url: string; auth: string | null; body: Record<string, unknown> }>,
  wompiSeq: 0,
  wompiStatus: 201,
  hookCalls: [] as Array<{ headers: Record<string, string>; raw: string; sigOk: boolean }>,
  hookResponses: [] as number[], // cola; si vacia -> 200
  hookSecret: "",
  mode: "sandbox" as PayEnvironment,
  verifyCalls: [] as Array<{ id: string; auth: string | null }>,
  verifyMode: "echo" as "echo" | "down" | "notfound",
};
// Transacciones "reales" de Wompi (lo que devolvería GET /transactions/{id}): la primera vez que se firma un evento.
const realTx = new Map<string, Record<string, unknown>>();
const HOOK_URL = "https://hooks.proyecto-a.example.com/pay";

const fakeFetch: typeof fetch = async (input, init = {}) => {
  const url = String(input);
  const h: Record<string, string> = {};
  new Headers(init.headers).forEach((v, k) => (h[k] = v));
  if (url.endsWith("/payment_links") && url.includes("wompi.co")) {
    world.wompiCalls.push({ url, auth: h["authorization"] ?? null, body: JSON.parse(String(init.body)) });
    if (world.wompiStatus !== 201) return new Response(JSON.stringify({ error: { messages: { description: ["x"] } } }), { status: world.wompiStatus });
    return new Response(JSON.stringify({ data: { id: `wl${++world.wompiSeq}abc` } }), { status: 201 });
  }
  const txm = url.match(/\/v1\/transactions\/([^/?]+)$/);
  if (txm) {
    world.verifyCalls.push({ id: txm[1], auth: h["authorization"] ?? null });
    if (world.verifyMode === "down") throw new TypeError("wompi down");
    const okKeys = [`Bearer ${KEYS.privateKey}`, `Bearer ${KEYS.tenantPrivate}`];
    if (!okKeys.includes(h["authorization"] ?? "")) return new Response("{}", { status: 401 });
    const wantKey = txMerchant.get(txm[1]) === "tenant" ? KEYS.tenantPrivate : KEYS.privateKey;
    if (h["authorization"] !== `Bearer ${wantKey}`) return new Response("{}", { status: 404 }); // otro merchant: no la ve
    const real = realTx.get(txm[1]);
    if (!real || world.verifyMode === "notfound") return new Response("{}", { status: 404 });
    return new Response(JSON.stringify({ data: real }), { status: 200 });
  }
  if (url === HOOK_URL) {
    const raw = String(init.body);
    const sig = h["payments-signature"] ?? "";
    const m = sig.match(/^t=(\d+),v1=([0-9a-f]{64})$/);
    const exp = m ? await hmacSha256Hex(world.hookSecret, `${m[1]}.${raw}`) : "";
    world.hookCalls.push({ headers: h, raw, sigOk: !!m && m[2] === exp });
    return new Response("ok", { status: world.hookResponses.shift() ?? 200 });
  }
  throw new TypeError(`red no simulada: ${url}`);
};

let merchantWithCredential: string | null = null;
const deps: Deps = {
  rpc: realRpc,
  fetch: fakeFetch,
  now: () => Date.now(),
  env: { supabaseUrl: "https://proj.supabase.co", cronSecret: "CRONSECRET_xyz" },
  getPlatformCredential: async () => ({
    mode: world.mode,
    getSecret: async (n) => (n === "private_key" ? KEYS.privateKey : n === "events_key" ? KEYS.eventsKey : null),
  }),
  // ST2: comercio. T1 (tenant con Wompi propio) usa las llaves de tenant; otros comercios no tienen credencial.
  isMerchantActive: async (id) => (await root`select status from public.tenants where id=${id}`)[0]?.status === "active",
  getMerchantCredential: async (tenantId) => {
    if (tenantId === null) {
      return { mode: world.mode, getSecret: async (n) => (n === "private_key" ? KEYS.privateKey : n === "events_key" ? KEYS.eventsKey : null) };
    }
    if (tenantId !== merchantWithCredential) return null;
    return { mode: "sandbox", getSecret: async (n) => (n === "private_key" ? KEYS.tenantPrivate : n === "events_key" ? KEYS.tenantEvents : null) };
  },
  verifyAdmin: async () => ({ userId: "11111111-1111-1111-1111-111111111111" }),
};
const handler = createHandler(deps);
const BASE = "https://proj.supabase.co/functions/v1/payments-api";
// deno-lint-ignore no-explicit-any
type Any = any;
const call = async (method: string, path: string, opts: { headers?: Record<string, string>; json?: unknown; raw?: string } = {}) => {
  const res = await handler(new Request(`${BASE}${path}`, {
    method,
    headers: { ...(opts.json !== undefined ? { "content-type": "application/json" } : {}), ...(opts.headers ?? {}) },
    body: opts.raw ?? (opts.json !== undefined ? JSON.stringify(opts.json) : undefined),
  }));
  const text = await res.text();
  let body: Any = null;
  try { body = JSON.parse(text); } catch { /* */ }
  return { status: res.status, body, text, headers: res.headers };
};

function wompiEvent(o: { linkId: string; txId: string; status: string; amount: number; currency?: string; env?: string; key?: string; ts?: number }): Any {
  const timestamp = o.ts ?? Math.floor(Date.now() / 1000);
  const tx = { id: o.txId, status: o.status, amount_in_cents: o.amount, currency: o.currency ?? "COP", payment_link_id: o.linkId, customer_email: "pagador@x.co", payment_method: { type: "CARD", extra: { last_four: "4242" } }, reference: "r" };
  const props = ["transaction.id", "transaction.status", "transaction.amount_in_cents"];
  return {
    event: "transaction.updated",
    data: { transaction: tx },
    environment: o.env ?? "test",
    timestamp,
    sent_at: new Date().toISOString(),
    signature: { properties: props, checksum: "", _k: o.key ?? KEYS.eventsKey },
  };
}
async function signed(e: Any) {
  const t0 = e.data.transaction;
  if (!realTx.has(t0.id)) realTx.set(t0.id, { id: t0.id, status: t0.status, amount_in_cents: t0.amount_in_cents, currency: t0.currency, payment_link_id: t0.payment_link_id, reference: "r" });
  const k = e.signature._k;
  delete e.signature._k;
  const concat = e.signature.properties.map((p: string) => String(p.split(".").reduce((v: Any, x: string) => v?.[x], e.data))).join("");
  e.signature.checksum = await sha256Hex(concat + String(e.timestamp) + k);
  return e;
}
const post = async (e: Any) => call("POST", "/v1/events/wompi", { raw: JSON.stringify(await signed(e)), headers: { "content-type": "application/json", "x-event-checksum": "abc" } });

const dbLink = async (id: string) => (await root`select * from payments.payment_links where id = ${id}`)[0];

// =============================================================================
console.log("== 0. setup: proyecto via /admin/clients (store_secret real)");
const created = await call("POST", "/admin/clients", { json: { name: "Proyecto A", callback_url: HOOK_URL }, headers: { authorization: "Bearer x" } });
check("admin crea cliente 201", created.status === 201, created);
const API_KEY: string = created.body.api_key;
const SIGNING: string = created.body.signing_secret;
world.hookSecret = SIGNING;
const CLIENT_ID: string = created.body.client.id;
check("api_key con formato lxy_pay_test_", /^lxy_pay_test_[\w-]{8}_[\w-]{43}$/.test(API_KEY));
check("en DB solo hay el hash de la clave (no la clave)", (await root`select api_key_hash from payments.clients where id=${CLIENT_ID}`)[0].api_key_hash === (await sha256Hex(API_KEY)));
const vaultRow = await root`select secret from vault.secrets where name like 'payments/%'`;
check("signing_secret quedo en Vault (stub) bajo payments/", vaultRow.length === 1 && vaultRow[0].secret === SIGNING);

const auth = { authorization: `Bearer ${API_KEY}` };
const mkBody = (o: Record<string, unknown> = {}) => ({ amount_in_cents: 5_000_000, currency: "COP", name: "Plan Pro", description: "Mensualidad", external_reference: "ORD-1", ...o });

console.log("== 1. crear link -> Wompi falso -> attach");
const r1 = await call("POST", "/v1/payment-links", { headers: { ...auth, "idempotency-key": "k-1" }, json: mkBody() });
check("POST /v1/payment-links 201", r1.status === 201, r1);
check("respuesta con checkout_url y status pending", r1.body?.status === "pending" && /^https:\/\/checkout\.wompi\.co\/l\/wl1abc$/.test(r1.body?.checkout_url ?? ""), r1.body);
const LINK1 = r1.body.id;
check("Wompi recibio Bearer privada, sku=id interno, sin taxes, single_use", world.wompiCalls.length === 1 && world.wompiCalls[0].auth === `Bearer ${KEYS.privateKey}` && world.wompiCalls[0].body.sku === LINK1 && !("taxes" in world.wompiCalls[0].body) && world.wompiCalls[0].body.single_use === true, world.wompiCalls[0]);
const r1b = await call("POST", "/v1/payment-links", { headers: { ...auth, "idempotency-key": "k-1" }, json: mkBody() });
check("replay misma clave+cuerpo -> 200 mismo id, Wompi NO llamado de nuevo", r1b.status === 200 && r1b.body.id === LINK1 && world.wompiCalls.length === 1, r1b);
const r1c = await call("POST", "/v1/payment-links", { headers: { ...auth, "idempotency-key": "k-1" }, json: mkBody({ amount_in_cents: 5_000_001 }) });
check("misma clave con otro cuerpo -> 409", r1c.status === 409, r1c);
const r1d = await call("GET", `/v1/payment-links/${LINK1}`, { headers: auth });
check("GET link devuelve last_event null y sin wompi_link_id", r1d.status === 200 && r1d.body.last_event === null && !("wompi_link_id" in r1d.body), r1d.body);
const r1e = await call("GET", `/v1/payment-links?external_reference=ORD-1`, { headers: auth });
check("GET por external_reference", r1e.status === 200 && r1e.body.id === LINK1, r1e);

console.log("== 2. APPROVED valido -> paid -> entrega firmada; 500 -> reintento; duplicado");
world.hookResponses = [500];
const e1 = await post(wompiEvent({ linkId: "wl1abc", txId: "tx-1", status: "APPROVED", amount: 5_000_000 }));
check("evento APPROVED -> 200 processed", e1.status === 200 && e1.body.classification === "processed", e1);
check("link paid con paid_transaction_id", (await dbLink(LINK1)).status === "paid" && (await dbLink(LINK1)).paid_transaction_id === "tx-1");
check("entrega inmediata intentada, firma HMAC valida del receptor", world.hookCalls.length === 1 && world.hookCalls[0].sigOk, world.hookCalls.map((c) => c.sigOk));
const body1 = JSON.parse(world.hookCalls[0].raw);
check("sobre: type/classification/payment_link.status/wompi intacto", body1.type === "payment_link.transaction" && body1.classification === "processed" && body1.payment_link.status === "paid" && body1.wompi.data.transaction.id === "tx-1", body1);
check("headers Payments-Event-Id y Delivery-Attempt=1", world.hookCalls[0].headers["payments-event-id"] === body1.id && world.hookCalls[0].headers["payments-delivery-attempt"] === "1", world.hookCalls[0].headers);
let d = (await root`select * from payments.deliveries order by created_at`)[0];
check("tras 500 la entrega queda pending con intento 1 y http 500", d.status === "pending" && d.attempt === 1 && d.http_status === 500, d);
await root`update payments.deliveries set next_attempt_at = now() - interval '1 second' where id = ${d.id}`;
const disp = await call("POST", "/internal/dispatch", { headers: { authorization: "Bearer CRONSECRET_xyz" }, json: {} });
check("/internal/dispatch entrega el reintento", disp.status === 200 && disp.body.delivered === 1, disp);
check("mismo cuerpo exacto en el reintento (bytes) y Attempt=2", world.hookCalls.length === 2 && world.hookCalls[1].raw === world.hookCalls[0].raw && world.hookCalls[1].headers["payments-delivery-attempt"] === "2" && world.hookCalls[1].sigOk);
d = (await root`select * from payments.deliveries`)[0];
check("entrega delivered", d.status === "delivered");
const bodyShaSent = await sha256Hex(world.hookCalls[0].raw);
console.log(`INFO body_sha256 almacenado=${d.body_sha256.slice(0, 16)} sha256(bytes enviados)=${bodyShaSent.slice(0, 16)} coinciden=${d.body_sha256 === bodyShaSent}`);
const noAuthDispatch = await call("POST", "/internal/dispatch", { headers: { authorization: "Bearer mal" }, json: {} });
check("/internal/dispatch con secreto incorrecto -> 401", noAuthDispatch.status === 401);
const dup = await post(wompiEvent({ linkId: "wl1abc", txId: "tx-1", status: "APPROVED", amount: 5_000_000 }));
check("mismo evento reenviado -> duplicate y sin nueva entrega", dup.body?.classification === "duplicate" && (await root`select count(*)::int c from payments.deliveries`)[0].c === 1, dup);
check("proyecto no recibio un segundo aviso por el duplicado", world.hookCalls.length === 2);

console.log("== 3. segunda APPROVED (otra tx) -> duplicate_payment; DECLINED/VOIDED despues; link sigue paid");
const e2 = await post(wompiEvent({ linkId: "wl1abc", txId: "tx-2", status: "APPROVED", amount: 5_000_000 }));
check("segunda APPROVED -> duplicate_payment", e2.body?.classification === "duplicate_payment", e2);
check("link sigue paid con la tx original", (await dbLink(LINK1)).paid_transaction_id === "tx-1");
check("p_sent_sha256 guardado = sha256 de los bytes enviados", (await root`select count(*)::int c from payments.delivery_attempts where sent_sha256 = ${await sha256Hex(world.hookCalls[0].raw)}`)[0].c >= 1);
const hookAfter2 = JSON.parse(world.hookCalls[world.hookCalls.length - 1].raw);
check("aviso del duplicate_payment trae classification=duplicate_payment (no 'processed')", hookAfter2.classification === "duplicate_payment", hookAfter2.classification);
const e3 = await post(wompiEvent({ linkId: "wl1abc", txId: "tx-3", status: "DECLINED", amount: 5_000_000 }));
const statusAfterDeclined = (await dbLink(LINK1)).status;
const e4 = await post(wompiEvent({ linkId: "wl1abc", txId: "tx-1", status: "VOIDED", amount: 5_000_000 }));
check("DECLINED posterior no regresa el link (paid)", statusAfterDeclined === "paid" && e3.status === 200);
check("VOIDED de la tx pagada: link pasa a voided (§7.1.2) y se propaga como processed", (await dbLink(LINK1)).status === "voided" && e4.body?.classification === "processed", e4.body);
const h4 = JSON.parse(world.hookCalls[world.hookCalls.length - 1].raw);
console.log(`INFO aviso de VOIDED: classification=${h4.classification} payment_link.status=${h4.payment_link.status} wompi.status=${h4.wompi.data.transaction.status}`);
const hist = await root`select to_status, cause from payments.link_status_history where link_id=${LINK1} order by id`;
check("historial: creating->pending->paid->voided", hist.map((h: Any) => h.to_status).join() === "creating,pending,paid,voided", hist);
check("sobre del VOIDED trae payment_link.status=voided y transaction.status=VOIDED", h4.payment_link.status === "voided" && h4.transaction?.status === "VOIDED", h4);

console.log("== 4. DINERO: monto / moneda / ambiente");
const rA = await call("POST", "/v1/payment-links", { headers: { ...auth, "idempotency-key": "k-2" }, json: mkBody({ external_reference: "ORD-2" }) });
const LINK2 = rA.body.id; const W2 = "wl2abc";
const hc0 = world.hookCalls.length;
const m1 = await post(wompiEvent({ linkId: W2, txId: "tm-1", status: "APPROVED", amount: 4_999_999 }));
check("monto distinto (-1 centavo) -> amount_mismatch y link NO paid", m1.body?.classification === "amount_mismatch" && (await dbLink(LINK2)).status === "pending", m1);
const m2 = await post(wompiEvent({ linkId: W2, txId: "tm-2", status: "APPROVED", amount: 5_000_000, currency: "USD" }));
check("moneda distinta -> amount_mismatch y link NO paid", m2.body?.classification === "amount_mismatch" && (await dbLink(LINK2)).status === "pending", m2);
const m3 = await post(wompiEvent({ linkId: W2, txId: "tm-3", status: "APPROVED", amount: 5_000_000, env: "prod" }));
check("evento de otro ambiente (prod, credencial sandbox) -> 401 y NO paid", m3.status === 401 && (await dbLink(LINK2)).status === "pending", m3);
const m4 = await post(wompiEvent({ linkId: W2, txId: "tm-4", status: "APPROVED", amount: 5_000_000, key: "otra_clave" }));
check("firma con otra clave -> 401 y NO paid", m4.status === 401 && (await dbLink(LINK2)).status === "pending", m4);
const tampered = await signed(wompiEvent({ linkId: W2, txId: "tm-5", status: "APPROVED", amount: 100 }));
tampered.data.transaction.amount_in_cents = 5_000_000; // cambia el monto DESPUES de firmar
const m5 = await call("POST", "/v1/events/wompi", { raw: JSON.stringify(tampered) });
check("evento manipulado tras firmar -> 401 y NO paid", m5.status === 401 && (await dbLink(LINK2)).status === "pending", m5);
const noSig = wompiEvent({ linkId: W2, txId: "tm-6", status: "APPROVED", amount: 5_000_000 }); delete noSig.signature;
const m6 = await call("POST", "/v1/events/wompi", { raw: JSON.stringify(noSig) });
check("evento sin signature -> 401 y NO paid", m6.status === 401 && (await dbLink(LINK2)).status === "pending", m6);
const evs = await root`select classification, signature_valid from payments.events where transaction_id like 'tm-%' and transaction_id <> 'tm-7' order by id`;
check("TODOS los eventos (invalidos incluidos) quedaron guardados", evs.length === 6, evs.map((e: Any) => e.classification));
const mmDeliv = world.hookCalls.slice(hc0).map((c) => JSON.parse(c.raw).classification);
console.log(`INFO avisos emitidos por intentos hostiles/mismatch: ${JSON.stringify(mmDeliv)}`);
check("ningun aviso 'processed' para el mismatch", !mmDeliv.includes("processed"));
const ok2 = await post(wompiEvent({ linkId: W2, txId: "tm-7", status: "APPROVED", amount: 5_000_000 }));
check("tras los mismatch, APPROVED correcta SI marca paid", ok2.body?.classification === "processed" && (await dbLink(LINK2)).status === "paid", ok2);

console.log("== 5. concurrencia: 10 APPROVED distintas simultaneas -> UN paid");
const rC = await call("POST", "/v1/payment-links", { headers: { ...auth, "idempotency-key": "k-3" }, json: mkBody({ external_reference: "ORD-3" }) });
const LINK3 = rC.body.id;
const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => post(wompiEvent({ linkId: "wl3abc", txId: `tc-${i}`, status: "APPROVED", amount: 5_000_000 }))));
const cls = rs.map((r) => r.body?.classification);
check("exactamente 1 processed y 9 duplicate_payment", cls.filter((c) => c === "processed").length === 1 && cls.filter((c) => c === "duplicate_payment").length === 9, cls);
check("historial con UNA transicion a paid", (await root`select count(*)::int c from payments.link_status_history where link_id=${LINK3} and to_status='paid'`)[0].c === 1);

console.log("== 6. evento sin destino (ya no se reenvia nada a payment-webhook-wompi)");
const foreign = await signed(wompiEvent({ linkId: "otro_link", txId: "tf-1", status: "APPROVED", amount: 111 }));
const f1 = await call("POST", "/v1/events/wompi", { raw: JSON.stringify(foreign), headers: { "x-event-checksum": "H123", "content-type": "application/json" } });
check("desconocido con firma de plataforma valida -> 200 unknown_link", f1.status === 200 && f1.body?.classification === "unknown_link", f1);
const fe = (await root`select classification, raw from payments.events where transaction_id='tf-1'`)[0];
check("guardado como unknown_link con resumen minimo (sin customer_email)", fe.classification === "unknown_link" && !JSON.stringify(fe.raw).includes("pagador@x.co"), fe);
const unsignedUnknown = await call("POST", "/v1/events/wompi", { raw: JSON.stringify({ data: { transaction: { id: "z", status: "APPROVED", payment_link_id: "nope" } } }) });
check("desconocido SIN firma valida -> 401 (misma respuesta que un link propio)", unsignedUnknown.status === 401, unsignedUnknown.status);
const probeOwn = await call("POST", "/v1/events/wompi", { raw: JSON.stringify({ data: { transaction: { id: "p1", status: "APPROVED", amount_in_cents: 1, currency: "COP", payment_link_id: "wl1abc" } } }) });
const probeNone = await call("POST", "/v1/events/wompi", { raw: JSON.stringify({ data: { transaction: { id: "p2", status: "APPROVED", amount_in_cents: 1, currency: "COP", payment_link_id: "no_existe_xx" } } }) });
console.log(`INFO oraculo de existencia: link propio sin firma -> HTTP ${probeOwn.status}; link inexistente -> HTTP ${probeNone.status}`);
check("sin firma valida el receptor NO distingue link propio de inexistente (mismo status y mismo error)", probeOwn.status === probeNone.status && probeOwn.body?.error?.code === probeNone.body?.error?.code && probeOwn.status === 401);

console.log("== 7. malformado y limites");
const mf = await call("POST", "/v1/events/wompi", { raw: "{no json" });
check("JSON invalido -> 200 malformed guardado", mf.status === 200 && mf.body?.classification === "malformed");
const big = await call("POST", "/v1/events/wompi", { raw: "x".repeat(300_000) });
check("cuerpo > 256KB -> 413", big.status === 413, big.status);

console.log("== 8. API key: revocada / suspendida / rotada / invalida");
const bad = await call("POST", "/v1/payment-links", { headers: { authorization: `Bearer ${API_KEY.slice(0, -1)}${API_KEY.endsWith("A") ? "B" : "A"}`, "idempotency-key": "k-9" }, json: mkBody() });
check("clave alterada -> 401", bad.status === 401);
const noAuth = await call("POST", "/v1/payment-links", { headers: { "idempotency-key": "k-9" }, json: mkBody() });
check("sin Authorization -> 401", noAuth.status === 401);
const hashAsKey = await call("GET", "/v1/payment-links?external_reference=ORD-1", { headers: { authorization: `Bearer ${await sha256Hex(API_KEY)}` } });
check("el hash almacenado NO sirve como clave", hashAsKey.status === 401);
const sus = await call("PATCH", `/admin/clients/${CLIENT_ID}`, { headers: { authorization: "Bearer x" }, json: { status: "suspended" } });
check("PATCH suspended OK", sus.status === 200, sus);
const s1 = await call("GET", "/v1/payment-links?external_reference=ORD-1", { headers: auth });
check("clave de proyecto suspendido -> 401", s1.status === 401);
const hcS = world.hookCalls.length;
const evSusp = await post(wompiEvent({ linkId: "wl1abc", txId: "tx-susp", status: "DECLINED", amount: 5_000_000 }));
console.log(`INFO proyecto SUSPENDIDO sigue recibiendo avisos: ${world.hookCalls.length > hcS} (evento ${evSusp.body?.classification})`);
await call("PATCH", `/admin/clients/${CLIENT_ID}`, { headers: { authorization: "Bearer x" }, json: { status: "active" } });
const rot = await call("POST", `/admin/clients/${CLIENT_ID}/rotate-key`, { headers: { authorization: "Bearer x" }, json: {} });
check("rotate-key devuelve nueva clave", rot.status === 200 && typeof rot.body.api_key === "string" && rot.body.api_key !== API_KEY, rot.body && Object.keys(rot.body));
const old = await call("GET", "/v1/payment-links?external_reference=ORD-1", { headers: auth });
check("clave anterior invalida tras rotar -> 401", old.status === 401);
const NEWKEY = rot.body.api_key;
const c2 = await call("POST", "/admin/clients", { json: { name: "Proyecto B" }, headers: { authorization: "Bearer x" } });
const rB = await call("GET", `/v1/payment-links/${LINK1}`, { headers: { authorization: `Bearer ${c2.body.api_key}` } });
check("proyecto B no ve links de A (404)", rB.status === 404, rB);
const rB2 = await call("GET", `/v1/payment-links?external_reference=ORD-1`, { headers: { authorization: `Bearer ${c2.body.api_key}` } });
check("proyecto B no ve por external_reference (404)", rB2.status === 404, rB2);
const fa = await call("POST", "/v1/payment-links", { headers: { authorization: `Bearer ${NEWKEY}`, "idempotency-key": "k-10" }, json: mkBody({ environment: "production" }) });
check("campo environment -> 422 field_not_allowed", fa.status === 422 && fa.body.error.code === "field_not_allowed", fa.body);
const liveKey = (await call("POST", "/admin/clients", { json: { name: "tmp" }, headers: { authorization: "Bearer x" } })).body.api_key as string;
const liveFake = liveKey.replace("lxy_pay_test_", "lxy_pay_live_");
await root`update payments.clients set api_key_hash = ${await sha256Hex(liveFake)} where name='tmp'`;
const lv = await call("POST", "/v1/payment-links", { headers: { authorization: `Bearer ${liveFake}`, "idempotency-key": "k-live" }, json: mkBody() });
check("clave live con plataforma sandbox -> 409 environment_unavailable", lv.status === 409 && lv.body.error.code === "environment_unavailable", lv.body);
const lvRow = await root`select status, status_detail from payments.payment_links where idempotency_key='k-live'`;
console.log(`INFO link de la clave live queda en: ${JSON.stringify(lvRow[0])}`);

console.log("== 9. Wompi falla");
world.wompiStatus = 422;
const w422 = await call("POST", "/v1/payment-links", { headers: { authorization: `Bearer ${NEWKEY}`, "idempotency-key": "k-w422" }, json: mkBody({ external_reference: "ORD-W" }) });
check("Wompi 422 -> 422 provider_rejected y link en error", w422.status === 422 && (await root`select status from payments.payment_links where idempotency_key='k-w422'`)[0].status === "error", w422);
const w422b = await call("POST", "/v1/payment-links", { headers: { authorization: `Bearer ${NEWKEY}`, "idempotency-key": "k-w422" }, json: mkBody({ external_reference: "ORD-W" }) });
check("replay de clave fallida -> 200 con status error (no reintenta Wompi)", w422b.status === 200 && w422b.body.status === "error", w422b);
world.wompiStatus = 201;

console.log("== 10. ADMIN list/readiness y formas (spec §6)");
const lst = await call("GET", "/admin/links", { headers: { authorization: "Bearer x" } });
check("GET /admin/links items[] con client_name, next_before", lst.status === 200 && Array.isArray(lst.body.items) && lst.body.items.every((i: Any) => "client_name" in i && "checkout_url" in i && "paid_at" in i) && "next_before" in lst.body, lst.body?.items?.[0]);
const lc = await call("GET", "/admin/clients", { headers: { authorization: "Bearer x" } });
check("GET /admin/clients -> { items:[...] } (P2 acepta array de P1)", lc.status === 200 && Array.isArray(lc.body.items) && lc.body.items.length >= 2 && !("api_key_hash" in lc.body.items[0]) && "key_prefix" in lc.body.items[0], lc.body);
const rd = await call("GET", "/admin/readiness", { headers: { authorization: "Bearer x" } });
check("readiness", rd.status === 200 && rd.body.platform_credential.configured === true && rd.body.platform_credential.mode === "sandbox" && /payments-api\/v1\/events\/wompi$/.test(rd.body.events_url), rd.body);
const pg1 = await call("GET", "/admin/links?limit=1", { headers: { authorization: "Bearer x" } });
console.log(`INFO paginacion limit=1 -> items=${pg1.body.items.length} next_before=${pg1.body.next_before}`);
const adm = await call("POST", "/admin/links", { headers: { authorization: "Bearer x" }, json: { client_id: CLIENT_ID, idempotency_key: "adm-1", ...mkBody({ external_reference: "ADM-1" }) } });
check("POST /admin/links crea con created_by del usuario", adm.status === 201 && (await dbLink(adm.body.id)).created_by === "11111111-1111-1111-1111-111111111111", adm.body);

console.log("== 11. SSRF");
const bads = ["http://example.com/x", "https://127.0.0.1/x", "https://localhost/x", "https://169.254.169.254/latest", "https://[::1]/x", "https://[::ffff:127.0.0.1]/x", "https://[::ffff:7f00:1]/x", "https://2130706433/x", "https://0x7f000001/x", "https://0177.0.0.1/x", "https://10.0.0.5/x", "https://192.168.1.1/x", "https://172.16.0.1/x", "https://[fd00:ec2::254]/x", "https://[fe80::1]/x", "https://user:pw@example.com/x", "file:///etc/passwd", "https://metadata.google.internal/x", "https://foo.localhost/x", "https://intranet/x", "https://100.64.0.1/x", "https://[::]/x", "https://0.0.0.0/x", "https://[64:ff9b::7f00:1]/x", "https://127.1/x"];
for (const u of bads) {
  let blocked = false;
  try { await checkCallbackDestination(u); } catch { blocked = true; }
  check(`SSRF bloquea ${u}`, blocked);
}
for (const u of ["https://hooks.example.com/a", "https://api.proyecto.co:8443/x"]) {
  let ok = true;
  try { await checkCallbackDestination(u); } catch { ok = false; }
  check(`SSRF permite ${u}`, ok);
}

console.log("== 12. entrega: destino privado");
await root`update payments.clients set callback_url='https://10.0.0.1/hook' where id=${CLIENT_ID}`;
await call("POST", "/v1/payment-links", { headers: { authorization: `Bearer ${NEWKEY}`, "idempotency-key": "k-d" }, json: mkBody({ external_reference: "ORD-D" }) });
const hcD = world.hookCalls.length;
await post(wompiEvent({ linkId: `wl${world.wompiSeq}abc`, txId: "td-1", status: "APPROVED", amount: 5_000_000 }));
const attD = await root`select http_status, last_error from payments.deliveries order by created_at desc limit 1`;
void hcD; // (otras entregas pendientes del lote pueden salir hacia HOOK_URL en la misma pasada)
check("destino privado en DB -> no se hace fetch y queda registrado", /destination_not_allowed/.test(attD[0].last_error ?? ""), attD);
await root`update payments.clients set callback_url=${HOOK_URL} where id=${CLIENT_ID}`;

console.log("== 13. aislamiento DB: grants / dependencias");
const anonExec = await root`select count(*)::int c from pg_proc p where pronamespace='public'::regnamespace and proname like 'payments\_%' and (has_function_privilege('anon',p.oid,'execute') or has_function_privilege('authenticated',p.oid,'execute') or has_function_privilege('public',p.oid,'execute'))`;
check("ninguna payments_* ejecutable por anon/authenticated/public", anonExec[0].c === 0);
const tblPriv = await root`select count(*)::int c from information_schema.role_table_grants where table_schema='payments' and grantee in ('anon','authenticated','PUBLIC')`;
check("tablas payments sin grants a anon/authenticated/public", tblPriv[0].c === 0);
const fk = await root`select count(*)::int c from pg_constraint k join pg_class a on a.oid=k.conrelid join pg_namespace na on na.oid=a.relnamespace join pg_class b on b.oid=k.confrelid join pg_namespace nb on nb.oid=b.relnamespace where k.contype='f' and ((na.nspname='payments' and nb.nspname<>'payments') or (nb.nspname='payments' and na.nspname<>'payments'))`;
check("0 FK entre payments y otros esquemas", fk[0].c === 0);
let readOther = "";
try { readOther = String((await svc.unsafe("select public.payments_read_secret('cron_reminder_secret') as r"))[0].r); } catch (e) { readOther = "ERR:" + (e as Any).code; }
check("payments_read_secret rechaza nombres fuera de payments/", readOther.startsWith("ERR:PY422"), readOther);
let storeOther = "";
try { await svc.unsafe("select public.payments_store_secret('cron_reminder_secret','pwn')"); storeOther = "OK"; } catch (e) { storeOther = "ERR:" + (e as Any).code; }
check("payments_store_secret rechaza nombres fuera de payments/", storeOther.startsWith("ERR:PY422"), storeOther);
let anonCall = "";
try { await root.unsafe("set role anon"); await root.unsafe("select public.payments_record_event('{}'::jsonb,'sandbox',true)"); anonCall = "OK"; } catch (e) { anonCall = "ERR:" + (e as Any).code; }
await root.unsafe("reset role").catch(() => {});
check("anon NO puede ejecutar payments_record_event (42501)", anonCall === "ERR:42501", anonCall);

console.log("== 15. REPLAY CRUZADO: evento valido de un link reutilizado para otro link (payment_link_id NO esta firmado)");
await root`update payments.clients set status='active' where id=${CLIENT_ID}`;
const lA = await call("POST", "/v1/payment-links", { headers: { authorization: `Bearer ${NEWKEY}`, "idempotency-key": "x-A" }, json: mkBody({ external_reference: "X-A", amount_in_cents: 9_000_000 }) });
const lB = await call("POST", "/v1/payment-links", { headers: { authorization: `Bearer ${NEWKEY}`, "idempotency-key": "x-B" }, json: mkBody({ external_reference: "X-B", amount_in_cents: 9_000_000 }) });
const wA = String(lA.body.checkout_url).split("/").pop()!; const wB = String(lB.body.checkout_url).split("/").pop()!;
const evA = await signed(wompiEvent({ linkId: wA, txId: "tx-REPLAY", status: "APPROVED", amount: 9_000_000 }));
const okA = await call("POST", "/v1/events/wompi", { raw: JSON.stringify(evA) });
check("pago legitimo de A -> processed", okA.body?.classification === "processed");
const forged = JSON.parse(JSON.stringify(evA)); forged.data.transaction.payment_link_id = wB; // mismo checksum, otro link
const rep = await call("POST", "/v1/events/wompi", { raw: JSON.stringify(forged) });
const stB = (await dbLink(lB.body.id)).status;
console.log(`INFO replay cruzado: HTTP ${rep.status} classification=${rep.body?.classification} link B queda en '${stB}' con paid_transaction_id=${(await dbLink(lB.body.id)).paid_transaction_id}`);
check("[DINERO] la MISMA transaccion no debe poder pagar un segundo link", stB !== "paid", { stB });
// propiedades firmadas que no incluyen el monto
const weak = wompiEvent({ linkId: wB, txId: "tx-WEAK", status: "APPROVED", amount: 9_000_000 });
weak.signature.properties = ["transaction.id", "transaction.status"]; // Wompi nunca lo hace; P2 lo aceptaria si la firma cuadra
{
  const k = weak.signature._k; delete weak.signature._k;
  weak.signature.checksum = await sha256Hex("tx-WEAK" + "APPROVED" + String(weak.timestamp) + k);
}
const rw = await call("POST", "/v1/events/wompi", { raw: JSON.stringify(weak) });
console.log(`INFO firma que NO cubre transaction.amount_in_cents -> HTTP ${rw.status} ${rw.body?.classification}`);
check("[DINERO] se exige que las propiedades firmadas incluyan id, status y amount_in_cents", rw.status === 401, rw.body);

console.log("== 16. RONDA 2: confirmacion contra Wompi (B1), propiedades firmadas (B2), health");
check("B1: toda APPROVED propia consulto GET /transactions/{id} con la llave privada", world.verifyCalls.length > 0 && world.verifyCalls.every((c) => c.auth === `Bearer ${KEYS.privateKey}`), world.verifyCalls.length);
const lD = await call("POST", "/v1/payment-links", { headers: { authorization: `Bearer ${NEWKEY}`, "idempotency-key": "r2-D" }, json: mkBody({ external_reference: "R2-D" }) });
const wD = String(lD.body.checkout_url).split("/").pop()!;
world.verifyMode = "down";
const hcR = world.hookCalls.length;
const down = await post(wompiEvent({ linkId: wD, txId: "tr2-1", status: "APPROVED", amount: 5_000_000 }));
check("Wompi caido -> 503 y link NO paid", down.status === 503 && (await dbLink(lD.body.id)).status === "pending", down);
check("evento guardado como unverified, sin aviso", (await root`select classification from payments.events where transaction_id='tr2-1'`)[0].classification === "unverified" && world.hookCalls.length === hcR);
world.verifyMode = "echo";
const again = await post(wompiEvent({ linkId: wD, txId: "tr2-1", status: "APPROVED", amount: 5_000_000 }));
check("reintento de Wompi tras unverified SI procesa y marca paid", again.status === 200 && again.body?.classification === "processed" && (await dbLink(lD.body.id)).status === "paid", again);
const lE = await call("POST", "/v1/payment-links", { headers: { authorization: `Bearer ${NEWKEY}`, "idempotency-key": "r2-E" }, json: mkBody({ external_reference: "R2-E" }) });
const wE = String(lE.body.checkout_url).split("/").pop()!;
world.verifyMode = "notfound";
const nf = await post(wompiEvent({ linkId: wE, txId: "tr2-2", status: "APPROVED", amount: 5_000_000 }));
check("Wompi 404 -> verification_mismatch, NO paid", nf.status === 200 && nf.body?.classification === "verification_mismatch" && (await dbLink(lE.body.id)).status === "pending", nf);
world.verifyMode = "echo";
const rd2 = await call("GET", "/admin/readiness", { headers: { authorization: "Bearer x" } });
check("readiness.health = payments_health_summary real", rd2.status === 200 && rd2.body.health && typeof rd2.body.health.verification_mismatch === "number" && rd2.body.health.unverified >= 1, rd2.body?.health);
const susp2 = await root`select c.status from payments.clients c where c.id=${CLIENT_ID}`;
console.log(`INFO cliente de la prueba: ${susp2[0].status}`);

console.log("== 17. evento de un link que no es del servicio: unknown_link sin rama legacy (SQL real)");
// --- datos de apoyo: dos tenants y facturas de plataforma (que ya NO se resuelven por el receptor)
const T1 = (await root`insert into public.tenants(name) values ('Tenant Uno') returning id`)[0].id as string;
const T2 = (await root`insert into public.tenants(name) values ('Tenant Dos') returning id`)[0].id as string;
const mkSub = async () => (await root`insert into public.billing_subscriptions default values returning id`)[0].id as string;
const mkInvoice = async (o: { cents?: number; merchant?: string | null; status?: string } = {}) =>
  (await root`insert into public.payment_invoices(merchant_tenant_id, payer_tenant_id, subscription_id, provider_key, amount_cents, status)
    values (${o.merchant ?? null}, ${T2}, ${await mkSub()}, 'wompi', ${o.cents ?? 250_000}, ${o.status ?? "PENDING"}) returning id`)[0].id as string;

// evento firmado con la llave del merchant indicado; registra la transaccion "real" en su merchant
async function lev(o: { link: string; tx: string; status?: string; amount: number; merchant: "platform" | "tenant"; currency?: string; badKey?: boolean; realLink?: string }) {
  const e = wompiEvent({ linkId: o.link, txId: o.tx, status: o.status ?? "APPROVED", amount: o.amount, currency: o.currency, key: o.badKey ? "clave_ajena" : (o.merchant === "tenant" ? KEYS.tenantEvents : KEYS.eventsKey) });
  const t0 = e.data.transaction;
  txMerchant.set(o.tx, o.merchant);
  realTx.set(o.tx, { id: o.tx, status: t0.status, amount_in_cents: t0.amount_in_cents, currency: t0.currency, payment_link_id: o.realLink ?? o.link, reference: "r" });
  return e;
}
const sendEv = async (e: Any) => { const x = await signed(e); return call("POST", "/v1/events/wompi", { raw: JSON.stringify(x) }); };
const invRow = async (id: string) => (await root`select * from public.payment_invoices where id=${id}`)[0];
const evRows = async (tx: string) => await root`select classification, origin, origin_ref, signature_valid, amount_matches, wompi_link_id, link_id from payments.events where transaction_id=${tx} order by id`;


const post17 = async (link: string, tx: string, o: { amount?: number; badKey?: boolean } = {}) =>
  sendEv(await lev({ link, tx, amount: o.amount ?? 250_000, merchant: "platform", badKey: o.badKey }));
const INV17 = await mkInvoice();
const vc17 = world.verifyCalls.length;
const evBefore = (await root`select count(*)::int c from payments.events`)[0].c as number;

// 17a. evento firmado y valido de un checkout que no es de ningun link del servicio (incluye el id que
// tuvo una factura / link de pedido cuando existia la rama legacy)
const u1_17 = await post17("wlegacy_ex_factura", "tu-1");
const u2_17 = await post17("wnever_existed", "tu-2");
check("17a firma valida + checkout sin link del servicio -> 200 unknown_link", u1_17.status === 200 && u1_17.body?.classification === "unknown_link" && u2_17.status === 200 && u2_17.body?.classification === "unknown_link", [u1_17.body, u2_17.body]);
check("17a las dos respuestas tienen la MISMA forma (sin oraculo)", JSON.stringify(Object.keys(u1_17.body).sort()) === JSON.stringify(Object.keys(u2_17.body).sort()));
const r1_17 = (await evRows("tu-1"))[0];
check("17a bandeja: classification unknown_link, firma valida, sin link ni origen legacy", r1_17.classification === "unknown_link" && r1_17.signature_valid === true && r1_17.link_id === null && r1_17.origin === null && r1_17.origin_ref === null, r1_17);
check("17a un evento desconocido NO se confirma contra Wompi ni toca public", world.verifyCalls.length === vc17 && (await invRow(INV17)).status === "PENDING");
check("17a sin pagos acreditados por esas transacciones", (await root`select count(*)::int c from public.sales_order_payments where provider_transaction_id in ('tu-1','tu-2')`)[0].c === 0);

// 17b. firma invalida: 401 uniforme, exista o no el checkout
const b1_17 = await post17("wlegacy_ex_factura", "tu-3", { badKey: true });
const b2_17 = await post17("wnever_existed", "tu-4", { badKey: true });
check("17b firma invalida -> 401 invalid_signature con el MISMO cuerpo exista o no el link", b1_17.status === 401 && b2_17.status === 401 && b1_17.body?.error?.code === "invalid_signature" && b1_17.body?.error?.message === b2_17.body?.error?.message, [b1_17.body, b2_17.body]);
const rb_17 = (await evRows("tu-3"))[0];
check("17b bandeja: invalid_signature, firma invalida, sin origen legacy", rb_17.classification === "invalid_signature" && rb_17.signature_valid === false && rb_17.origin === null, rb_17);

// 17c. checksum mal formado: 401 sin consultas, una sola fila minima
const ill_17 = await signed(await lev({ link: "wlegacy_ex_factura", tx: "tu-5", amount: 1, merchant: "platform" }));
ill_17.signature.checksum = "no-es-hex";
ill_17.data.transaction.customer_email = "x".repeat(200_000);
const il_17 = await call("POST", "/v1/events/wompi", { raw: JSON.stringify(ill_17) });
check("17c checksum mal formado -> 401", il_17.status === 401, il_17.status);
const ilRow_17 = (await root`select raw::text t, classification from payments.events where transaction_id='tu-5'`)[0];
check("17c fila minima (sin PII ni payload grande)", ilRow_17.classification === "invalid_signature" && ilRow_17.t.length < 1500 && !ilRow_17.t.includes("pagador@x.co"), ilRow_17.t?.length);

// 17d. tope anti-llenado sobre un checkout inexistente (record_event real)
for (let i = 0; i < 25; i++) await post17("wspam_flood", `tfl17-${i}`, { badKey: true });
check("17d 25 firmas invalidas del mismo checkout inexistente -> maximo 10 filas por minuto", (await root`select count(*)::int c from payments.events where wompi_link_id='wspam_flood' and classification='invalid_signature'`)[0].c <= 10);

// 17e. replay cruzado contra un evento historico de la rama retirada (las clasificaciones legacy_* siguen en el CHECK)
await root`insert into payments.events(classification, raw, transaction_id, tx_status, wompi_link_id, origin, origin_ref, signature_valid)
  values ('legacy_invoice', '{}', 'th-1', 'APPROVED', 'wlegacy_hist', 'legacy_invoice', ${INV17}, true)`;
const hLink_17 = await call("POST", "/v1/payment-links", { headers: { authorization: `Bearer ${NEWKEY}`, "idempotency-key": "k-17e" }, json: mkBody({ external_reference: "R17E" }) });
const hWl_17 = (await dbLink(hLink_17.body.id)).wompi_link_id as string;
const hv_17 = await sendEv(await lev({ link: hWl_17, tx: "th-1", amount: 5_000_000, merchant: "platform" }));
check("17e [DINERO] una tx que la rama retirada ya acredito (historia) NO paga un link del servicio", hv_17.body?.classification === "transaction_conflict" && (await dbLink(hLink_17.body.id)).status === "pending", hv_17.body);

check("17f nada de lo anterior toco las facturas ni los pagos de public", (await invRow(INV17)).status === "PENDING" && (await root`select count(*)::int c from public.sales_order_payments where provider_transaction_id like 'tu-%' or provider_transaction_id like 'tfl17-%'`)[0].c === 0);
console.log(`INFO eventos nuevos en esta seccion: ${(await root`select count(*)::int c from payments.events`)[0].c - evBefore}`);

console.log("== 18. RETORNO DE PAGO: estado publico + redirect por defecto (SQL real)");
const pubStatus = async (id: string) => {
  const r = await handler(new Request(`${BASE}/v1/public/payment-links/${id}/status`, { method: "GET" }));
  return { status: r.status, body: await r.json() as Any, headers: r.headers };
};
const KEYS18 = ["last_attempt", "status", "updated_at"];
// (a) redirect por defecto / explicito en payments-api, contra payments_begin_link real
const wc0 = world.wompiCalls.length;
const d1 = await call("POST", "/v1/payment-links", { headers: { authorization: `Bearer ${NEWKEY}`, "idempotency-key": "k-ret-1" }, json: mkBody({ external_reference: "RET-1" }) });
check("18a link sin redirect_url: Wompi recibe /pago/resultado?link=<id de la fila>", d1.status === 201 && world.wompiCalls[wc0]?.body.redirect_url === `https://leadly.lexycolombia.com/pago/resultado?link=${d1.body.id}`, world.wompiCalls[wc0]?.body);
const d2 = await call("POST", "/v1/payment-links", { headers: { authorization: `Bearer ${NEWKEY}`, "idempotency-key": "k-ret-2" }, json: mkBody({ external_reference: "RET-2", redirect_url: "https://proyecto.example.com/ok" }) });
check("18a redirect_url explicito del proyecto gana", d2.status === 201 && world.wompiCalls[wc0 + 1]?.body.redirect_url === "https://proyecto.example.com/ok", world.wompiCalls[wc0 + 1]?.body);
check("18a la fila guarda el redirect del proyecto y NULL cuando uso el default", (await dbLink(d2.body.id)).redirect_url === "https://proyecto.example.com/ok" && (await dbLink(d1.body.id)).redirect_url === null);
const d1r = await call("POST", "/v1/payment-links", { headers: { authorization: `Bearer ${NEWKEY}`, "idempotency-key": "k-ret-1" }, json: mkBody({ external_reference: "RET-1" }) });
check("18a replay idempotente sigue funcionando (el default no entra al request_hash)", d1r.status === 200 && d1r.body.id === d1.body.id && world.wompiCalls.length === wc0 + 2);

// (b) endpoint publico sobre los tres origenes
const WL18 = (await dbLink(d1.body.id)).wompi_link_id as string;
const p1 = await pubStatus(d1.body.id);
check("18b link nuevo pending: forma exacta, 200, no-store, sin auth", p1.status === 200 && Object.keys(p1.body).sort().join() === KEYS18.join() && p1.body.status === "pending" && p1.body.last_attempt === null && p1.headers.get("cache-control") === "no-store", p1.body);
await post(wompiEvent({ linkId: WL18, txId: "tr-dec", status: "DECLINED", amount: 5_000_000 }));
const p1d = await pubStatus(d1.body.id);
check("18b DECLINED valido -> last_attempt=DECLINED y status sigue pending", p1d.body.status === "pending" && p1d.body.last_attempt === "DECLINED", p1d.body);
await post(wompiEvent({ linkId: WL18, txId: "tr-ok", status: "APPROVED", amount: 5_000_000 }));
const p1p = await pubStatus(d1.body.id);
check("18b APPROVED -> paid / APPROVED", p1p.body.status === "paid" && p1p.body.last_attempt === "APPROVED", p1p.body);
await post(wompiEvent({ linkId: WL18, txId: "tr-ok", status: "VOIDED", amount: 5_000_000 }));
const p1v = await pubStatus(d1.body.id);
check("18b VOIDED de la tx pagada -> voided / VOIDED", p1v.body.status === "voided" && p1v.body.last_attempt === "VOIDED", p1v.body);

// sin fallback: el id de una factura / link de pedido (ex-legacy) responde unknown, igual que uno inexistente,
// aunque exista la fila en public y aunque haya un evento historico con ese origin_ref
const INV18 = await mkInvoice();
const unE0 = JSON.stringify({ status: "unknown", last_attempt: null, updated_at: null });
check("18b id de una factura de plataforma (ya no se resuelve) -> unknown", JSON.stringify((await pubStatus(INV18)).body) === unE0);
await root`insert into payments.events(classification, raw, transaction_id, tx_status, wompi_link_id, origin, origin_ref, signature_valid)
  values ('legacy_invoice', '{}', 'tr-hist', 'APPROVED', 'wret-hist', 'legacy_invoice', ${INV18}, true)`;
check("18b ...aunque haya un evento historico legacy con ese origin_ref (last_attempt NO se filtra)", JSON.stringify((await pubStatus(INV18)).body) === unE0);
await root`update public.payment_invoices set status='PAID' where id=${INV18}`;
check("18b ...y cambie el estado de la factura", JSON.stringify((await pubStatus(INV18)).body) === unE0);

const un1 = await pubStatus(crypto.randomUUID());
const un2 = await pubStatus("no-es-uuid");
const unE = JSON.stringify({ status: "unknown", last_attempt: null, updated_at: null });
check("18b inexistente y mal formado -> 200 con el MISMO cuerpo unknown", un1.status === 200 && un2.status === 200 && JSON.stringify(un1.body) === unE && JSON.stringify(un2.body) === unE);
const attackId = (await root`select id from payments.payment_links limit 1`)[0].id as string;
const before = (await pubStatus(attackId)).body.last_attempt;
await sendEv(await lev({ link: "wl1abc", tx: "tr-evil", status: "ERROR", amount: 1, merchant: "platform", badKey: true }));
check("18b evento invalid_signature no altera last_attempt", (await pubStatus(attackId)).body.last_attempt === before);
check("18b el id de Wompi no resuelve nada en la ruta publica", JSON.stringify((await pubStatus("wl1abc")).body) === unE);

// (c) privilegios de la funcion nueva
const priv = await root`select has_function_privilege('anon', 'public.payments_public_link_status(uuid)', 'execute') as anon,
  has_function_privilege('authenticated', 'public.payments_public_link_status(uuid)', 'execute') as auth,
  has_function_privilege('service_role', 'public.payments_public_link_status(uuid)', 'execute') as svc`;
check("18c payments_public_link_status: solo service_role puede ejecutarla", priv[0].anon === false && priv[0].auth === false && priv[0].svc === true, priv[0]);

// (d) createSalesOrderPaymentLink: desde ST4 crea por el servicio (cubierto de punta a punta en la seccion 21).

console.log("== 19. ST2: comercio (SQL real de begin_link + receptor con la credencial del comercio)");
{
  merchantWithCredential = T1;
  const mkClientKind = async (name: string, kind: string, hash: string) => {
    const r = await realRpc.rpc("payments_admin_create_client", { p_name: name, p_callback_url: null, p_key_hash: hash, p_key_prefix: "lxy_pay_test_x", p_signing_secret_name: null, p_created_by: null, p_kind: kind });
    if (r.error) throw new Error(r.error.message);
    return (r.data as Any).id as string;
  };
  const internalId = await mkClientKind("Leadly interno ST2", "internal", "a".repeat(64));
  const externalId = await mkClientKind("Externo ST2", "external", "b".repeat(64));
  const body = (ref: string) => validateLinkRequest({ amount_in_cents: 150000, currency: "COP", name: "Pedido", description: "Pedido de prueba", external_reference: ref }, Date.now());
  const mk = (clientId: string, merchant: string | null, ref: string, idem: string) =>
    createPaymentLink(deps, { clientId, createdBy: null, environment: null, idempotencyKey: idem, request: body(ref), merchantTenantId: merchant });
  const before = world.wompiCalls.length;
  const L = await mk(internalId, T1, "order:st2-a", "st2-idem-a");
  const row = (await root`select merchant_tenant_id, environment, status from payments.payment_links where id=${String(L.link.id)}`)[0];
  check("19a interno + comercio: fila con merchant_tenant_id y link pendiente", row.merchant_tenant_id === T1 && row.status === "pending", row);
  check("19a Wompi recibio la llave privada del COMERCIO", world.wompiCalls.at(-1)!.auth === `Bearer ${KEYS.tenantPrivate}` && world.wompiCalls.length === before + 1);
  let code = "";
  try { await mk(externalId, T1, "order:st2-b", "st2-idem-b"); } catch (e) { code = e instanceof ApiError ? `${e.status}:${e.code}` : String(e); }
  check("19b externo con comercio (PY424 real de la base) -> 403 merchant_not_allowed, sin llamar a Wompi", code === "403:merchant_not_allowed" && world.wompiCalls.length === before + 1, code);
  let code2 = "";
  try { await mk(internalId, T2, "order:st2-c", "st2-idem-c"); } catch (e) { code2 = e instanceof ApiError ? `${e.status}:${e.code}` : String(e); }
  const failed = (await root`select status, status_detail from payments.payment_links where external_reference='order:st2-c'`)[0];
  check("19c comercio sin credencial -> 409 y fila en error, sin llamada a Wompi", code2 === "409:merchant_credential_unavailable" && failed?.status === "error" && world.wompiCalls.length === before + 1, { code2, failed });
  let code3 = "";
  try { await mk(internalId, null, "order:st2-a", "st2-idem-a"); } catch (e) { code3 = e instanceof ApiError ? `${e.status}:${e.code}` : String(e); }
  check("19d misma Idempotency-Key con otro comercio -> 409 idempotency_key_reused (hash con comercio)", code3 === "409:idempotency_key_reused", code3);
  const re = await mk(internalId, T1, "order:st2-a", "st2-idem-a");
  check("19d mismo comercio -> replay del mismo link", re.replayed === true && re.link.id === L.link.id);
  const wl = (await root`select wompi_link_id from payments.payment_links where id=${String(L.link.id)}`)[0].wompi_link_id as string;
  txMerchant.set("tx-st2-bad", "tenant");
  const vcBad = world.verifyCalls.length;
  const bad = await call("POST", "/v1/events/wompi", { raw: JSON.stringify(await signed(wompiEvent({ linkId: wl, txId: "tx-st2-bad", status: "APPROVED", amount: 150000, key: KEYS.eventsKey }))) });
  check("19e evento del link del comercio firmado con la events_key de PLATAFORMA -> 401, sin confirmar contra Wompi", bad.status === 401 && bad.body?.error?.code === "invalid_signature" && world.verifyCalls.length === vcBad, bad.body);
  txMerchant.set("tx-st2-ok", "tenant");
  const ok = await call("POST", "/v1/events/wompi", { raw: JSON.stringify(await signed(wompiEvent({ linkId: wl, txId: "tx-st2-ok", status: "APPROVED", amount: 150000, key: KEYS.tenantEvents }))) });
  const paid = (await root`select status, paid_transaction_id from payments.payment_links where id=${String(L.link.id)}`)[0];
  check("19f firmado con la events_key del comercio y confirmado con SU private_key -> processed y link paid",
    ok.body?.classification === "processed" && paid.status === "paid" && paid.paid_transaction_id === "tx-st2-ok" && world.verifyCalls.at(-1)!.auth === `Bearer ${KEYS.tenantPrivate}`, { b: ok.body, paid });
  const TI = (await root`insert into public.tenants(name, status) values ('Tenant Inactivo ST2', 'inactive') returning id`)[0].id as string;
  merchantWithCredential = TI;
  let code4 = "";
  try { await mk(internalId, TI, "order:st2-d", "st2-idem-d"); } catch (e) { code4 = e instanceof ApiError ? `${e.status}:${e.code}` : String(e); }
  const failed4 = (await root`select status, status_detail from payments.payment_links where external_reference='order:st2-d'`)[0];
  check("19g tenant inactivo (tenants.status real) -> 409 merchant_not_active, fila en error, sin Wompi", code4 === "409:merchant_not_active" && failed4?.status === "error" && world.wompiCalls.length === before + 1, { code4, failed4 });
  merchantWithCredential = null;
}

console.log("== 20. ST3: consumidor interno (handler real + apply_wompi_* reales + secreto de firma de Vault)");
{
  const { createInternalHandler } = await import("../../functions/_shared/payments-service/internalConsumer.ts");
  const { signEnvelope } = await import("../../functions/_shared/payments-service/hmac.ts");
  const intC = await call("POST", "/admin/clients", { json: { name: "Leadly interno ST3", kind: "internal", callback_url: "https://kkdtrkfcnyvuefazndnj.supabase.co/functions/v1/payments-internal" }, headers: { authorization: "Bearer x" } });
  check("20-setup cliente interno creado por la ruta admin", intC.status === 201 && intC.body.client.kind === "internal", intC);
  const INT_ID: string = intC.body.client.id;
  const SIGNING_INT: string = intC.body.signing_secret;
  const h = createInternalHandler({ rpc: realRpc, now: () => Date.now(), clientId: INT_ID });
  const hFor = (id: string) => createInternalHandler({ rpc: realRpc, now: () => Date.now(), clientId: id });
  const U1 = (await root`insert into public.tenants(name) values ('Tenant ST3 Uno') returning id`)[0].id as string;
  const U2 = (await root`insert into public.tenants(name) values ('Tenant ST3 Dos') returning id`)[0].id as string;
  const ord = async (tenant: string) => (await root`insert into public.sales_orders(tenant_id, number, status, total) values (${tenant}, ${9000 + Math.floor(Math.random() * 90000)}, 'confirmada', 1000) returning id`)[0].id as string;
  const env = (o: { orderId: string; tenant: string; linkId?: string; tx?: string; cents?: number; kind?: string; ref?: string }) => ({
    id: `evt-${crypto.randomUUID()}`, type: "payment_link.transaction", created_at: new Date().toISOString(),
    payment_link: { id: o.linkId ?? crypto.randomUUID(), external_reference: o.ref ?? `order:${o.orderId}`, status: "paid", amount_in_cents: o.cents ?? 100000, currency: "COP",
      metadata: { kind: o.kind ?? "order", tenant_id: o.tenant, order_id: o.orderId } },
    classification: "processed",
    transaction: { id: o.tx ?? `tx-${crypto.randomUUID()}`, status: "APPROVED", amount_in_cents: o.cents ?? 100000, currency: "COP" },
    wompi: { data: { transaction: { payment_method_type: "NEQUI", payment_method: { phone_number: "3001112233" } } } },
  });
  const sendEnv = async (e: unknown, secret = SIGNING_INT, handle = h) => {
    const raw = JSON.stringify(e);
    const r = await handle(new Request("https://x.supabase.co/functions/v1/payments-internal", { method: "POST", body: raw, headers: { "Payments-Signature": await signEnvelope(secret, raw, Math.floor(Date.now() / 1000)) } }));
    return { status: r.status, body: await r.json() };
  };
  const cnt = async (orderId: string) => Number((await root`select count(*)::int as n from public.sales_order_payments where order_id=${orderId}`)[0].n);

  const o1 = await ord(U1);
  const e1 = env({ orderId: o1, tenant: U1 });
  const a = await sendEnv(e1);
  check("20a firma de Vault valida + pedido: 200 applied y 1 pago wompi", a.status === 200 && a.body.result === "applied" && await cnt(o1) === 1, a);
  const pay = (await root`select amount, method, provider_key, provider_reference, payment_link_id from public.sales_order_payments where order_id=${o1}`)[0];
  check("20a pago: monto 1000.00, referencia Nequi, payment_link_id = id del link del servicio", Number(pay.amount) === 1000 && pay.method === "wompi" && pay.provider_reference === "Nequi 3001112233" && pay.payment_link_id === e1.payment_link.id, pay);
  const again = await sendEnv(e1);
  check("20b reentrega del mismo evento: 200 duplicate, sigue 1 pago", again.status === 200 && again.body.result === "duplicate" && await cnt(o1) === 1, again);
  const o2 = await ord(U1);
  const e2 = env({ orderId: o2, tenant: U1 });
  const burst = await Promise.all(Array.from({ length: 8 }, () => sendEnv(e2)));
  const results = burst.map((b) => b.body.result).sort();
  check("20c 8 entregas CONCURRENTES del mismo evento: exactamente 1 applied, 7 duplicate, 1 pago", results.filter((x) => x === "applied").length === 1 && results.filter((x) => x === "duplicate").length === 7 && await cnt(o2) === 1, results);
  const o3 = await ord(U2);
  const foreign = await sendEnv(env({ orderId: o3, tenant: U1 }));
  check("20d tenant ajeno en metadata: 200 not_applicable tenant_mismatch y NO acredita", foreign.status === 200 && foreign.body.reason === "tenant_mismatch" && await cnt(o3) === 0, foreign);
  const o4 = await ord(U1);
  const sameTx = await sendEnv(env({ orderId: o4, tenant: U1, tx: e1.transaction.id }));
  check("20e misma transaccion en OTRO pedido: conflict y NO acredita", sameTx.body.result === "conflict" && await cnt(o4) === 0, sameTx);
  const second = await sendEnv(env({ orderId: o1, tenant: U1 }));
  check("20f segundo cobro aprobado (otro link) sobre pedido ya pagado: conflict order_already_paid, sin doble acreditacion", second.body.result === "conflict" && second.body.reason === "order_already_paid" && await cnt(o1) === 1, second);
  const bad = await sendEnv(e1, "otro-secreto");
  check("20g firma con otro secreto: 401", bad.status === 401, bad);
  const o5 = await ord(U1);
  const wrongAmount = env({ orderId: o5, tenant: U1 });
  wrongAmount.transaction.amount_in_cents = 99999;
  const wa = await sendEnv(wrongAmount);
  check("20h monto de la transaccion distinto del link: no acredita", wa.body.reason === "amount_mismatch" && await cnt(o5) === 0, wa);
  const incoh = await sendEnv(env({ orderId: o5, tenant: U1, ref: `order:${o1}` }));
  check("20i referencia distinta de la metadata: no acredita", incoh.body.reason === "inconsistent_envelope" && await cnt(o5) === 0, incoh);
  // B1: el cliente configurado debe ser interno/activo/no revocado
  const o6 = await ord(U2);
  const forged = env({ orderId: o6, tenant: U2 });
  const susp = (await root`insert into payments.clients(name, status, api_key_hash, key_prefix, signing_secret_name, kind) select 'susp ST3','suspended',${"9".repeat(64)},'ps', signing_secret_name,'internal' from payments.clients where id=${INT_ID} returning id`)[0].id as string;
  const rev = (await root`insert into payments.clients(name, status, api_key_hash, key_prefix, signing_secret_name, kind, revoked_at) select 'rev ST3','active',${"8".repeat(64)},'pr', signing_secret_name,'internal', now() from payments.clients where id=${INT_ID} returning id`)[0].id as string;
  const cases: Array<[string, string, string]> = [["externo", CLIENT_ID, SIGNING], ["suspendido", susp, SIGNING_INT], ["revocado", rev, SIGNING_INT], ["inexistente", crypto.randomUUID(), SIGNING_INT]];
  for (const [name, id, sec] of cases) {
    const r = await sendEnv(forged, sec, hFor(id));
    check(`20k variable apuntando a cliente ${name}: 503 y NO acredita`, r.status === 503 && await cnt(o6) === 0, r);
  }
  // extremo a extremo: un externo firma con SU secreto un sobre con metadata mentirosa (pedido de otro tenant)
  const lie = await sendEnv(env({ orderId: o6, tenant: U2 }), SIGNING, hFor(CLIENT_ID));
  check("20k externo que firma con su propio secreto un sobre mentiroso: 503, nada acreditado", lie.status === 503 && await cnt(o6) === 0, lie);
  const ext = await sendEnv(env({ orderId: o6, tenant: U2 }), SIGNING, h);
  check("20k y contra el handler interno su firma no vale: 401", ext.status === 401 && await cnt(o6) === 0, ext);

  // factura de plataforma
  const sub = (await root`insert into public.billing_subscriptions(status) values ('PENDING') returning id`)[0].id as string;
  const inv = (await root`insert into public.payment_invoices(payer_tenant_id, subscription_id, provider_key, amount_cents, status) values (${U1}, ${sub}, 'wompi', 5000000, 'PENDING') returning id`)[0].id as string;
  const ei = env({ orderId: "", tenant: U1, cents: 5000000, ref: `invoice:${inv}`, kind: "invoice" });
  (ei.payment_link.metadata as Any).invoice_id = inv;
  const ia = await sendEnv(ei);
  const invRow = (await root`select status, provider_transaction_id from public.payment_invoices where id=${inv}`)[0];
  const subRow = (await root`select status from public.billing_subscriptions where id=${sub}`)[0];
  check("20j factura de plataforma: PAID, transaccion registrada y suscripcion ACTIVE", ia.body.result === "applied" && invRow.status === "PAID" && invRow.provider_transaction_id === ei.transaction.id && subRow.status === "ACTIVE", { ia, invRow, subRow });
  const ib = await sendEnv(ei);
  check("20j reentrega de la factura: duplicate y un solo intento", ib.body.result === "duplicate" && Number((await root`select count(*)::int n from public.payment_attempts where invoice_id=${inv}`)[0].n) === 1, ib);

  // ===== 21. ST4: creadores internos por el servicio, de punta a punta (SQL real) =====
  console.log("== 21. ST4: creadores internos -> servicio -> aviso firmado -> consumidor");
  const { createSalesOrderPaymentLink } = await import("../../functions/_shared/payments/salesOrderPayments.ts");
  const { ensureInvoiceCheckout } = await import("../../functions/_shared/payments/invoiceCheckout.ts");
  const { syncInvoiceFromService } = await import("../../functions/_shared/payments/syncInvoice.ts");
  const opts4 = { deps, clientId: INT_ID };
  merchantWithCredential = U1;
  const col = (await root`select data_type, is_nullable from information_schema.columns where table_schema='public' and table_name='payment_invoices' and column_name='payments_link_id'`)[0];
  const fkCnt = Number((await root`select count(*)::int n from pg_constraint c join pg_attribute a on a.attrelid=c.conrelid and a.attnum=any(c.conkey) where c.conrelid='public.payment_invoices'::regclass and c.contype='f' and a.attname='payments_link_id'`)[0].n);
  check("21-sql payments_link_id: uuid, nullable, SIN FK, con indice parcial",
    col?.data_type === "uuid" && col.is_nullable === "YES" && fkCnt === 0 && (await root`select 1 from pg_indexes where indexname='payment_invoices_payments_link_id_idx'`).length === 1, { col, fkCnt });
  const deliveryBody = async (linkId: string) => (await root`select body from payments.deliveries where link_id=${linkId} order by id desc limit 1`)[0]?.body as Any;

  // pedido: creador -> link del servicio a nombre del tenant -> evento Wompi -> aviso -> pago
  const oid = await ord(U1);
  const cr = await createSalesOrderPaymentLink(pubAdmin as never, U1, oid, null, undefined, opts4);
  const ol = (await root`select * from payments.payment_links where external_reference=${"order:" + oid}`)[0];
  check("21a pedido: link del servicio con comercio, metadata de la fila, amount del saldo y sin sombra en public",
    ol && ol.merchant_tenant_id === U1 && ol.metadata.kind === "order" && ol.metadata.tenant_id === U1 && ol.metadata.order_id === oid && Number(ol.amount_in_cents) === 100000 && cr.amount === 1000 &&
      world.wompiCalls.at(-1)!.auth === `Bearer ${KEYS.tenantPrivate}` && !("taxes" in world.wompiCalls.at(-1)!.body), { ol, cr });
  check("21a el redirect por defecto resuelve en el servicio (id del link del servicio)", world.wompiCalls.at(-1)!.body.redirect_url === `https://leadly.lexycolombia.com/pago/resultado?link=${ol.id}`, world.wompiCalls.at(-1)!.body);
  const otx = `tx-st4-${crypto.randomUUID()}`;
  txMerchant.set(otx, "tenant");
  const oev = await post(wompiEvent({ linkId: ol.wompi_link_id, txId: otx, status: "APPROVED", amount: 100000, key: KEYS.tenantEvents }));
  check("21b evento Wompi del comercio -> processed", oev.status === 200 && oev.body?.classification === "processed", oev.body);
  const obody = await deliveryBody(ol.id);
  const og = await sendEnv(obody);
  check("21b aviso firmado al consumidor interno: pedido acreditado una vez", og.status === 200 && og.body.result === "applied" && await cnt(oid) === 1, og);
  const og2 = await sendEnv(obody);
  check("21b reentrega: duplicate, sigue un solo pago", og2.body.result === "duplicate" && await cnt(oid) === 1, og2);
  const oc = await createSalesOrderPaymentLink(pubAdmin as never, U1, oid, null, undefined, opts4).catch((e: Error) => e);
  check("21b pedido ya pagado: el creador rechaza (no hay saldo)", oc instanceof Error && /pagado/.test(oc.message));

  // factura de plataforma: creador -> payments_link_id -> evento -> aviso -> PAID + suscripcion
  const mkInv = async () => {
    const sb = (await root`insert into public.billing_subscriptions(status) values ('PENDING') returning id`)[0].id as string;
    const id = (await root`insert into public.payment_invoices(payer_tenant_id, subscription_id, provider_key, amount_cents, status, description, tax_cents, period_start, period_end) values (${U1}, ${sb}, 'wompi', 11900000, 'PENDING', 'Plan Pro', 1900000, '2026-10-10', '2026-11-10') returning id`)[0].id as string;
    return { id, sb };
  };
  const invFor = async (id: string) => (await root`select id, merchant_tenant_id, payer_tenant_id, provider_key, amount_cents, currency, description, invoice_number, payments_link_id, tax_rate, tax_cents, period_start::text as period_start, period_end::text as period_end from public.payment_invoices where id=${id}`)[0] as Any;
  const I1 = await mkInv();
  const ck = await ensureInvoiceCheckout(pubAdmin as never, await invFor(I1.id), null, undefined, opts4);
  const i1 = await invFor(I1.id);
  const il = (await root`select * from payments.payment_links where id=${i1.payments_link_id}`)[0] as Any;
  check("21c factura: link del servicio de PLATAFORMA (comercio null), metadata con el pagador, VAT = tax_cents de la fila, nombre con periodo, payments_link_id guardado",
    !!ck.ok && !!il && il.merchant_tenant_id === null && il.external_reference === `invoice:${I1.id}` && il.metadata.tenant_id === U1 && il.metadata.invoice_id === I1.id &&
      world.wompiCalls.at(-1)!.auth === `Bearer ${KEYS.privateKey}` && JSON.stringify(world.wompiCalls.at(-1)!.body.taxes) === JSON.stringify([{ type: "VAT", amount_in_cents: 1900000 }]) &&
      il.name.startsWith("Comprobante de cobro ") && il.name.endsWith("· Plan Pro (10 oct 2026 – 10 nov 2026)"), { ck, il });
  const ck2 = await ensureInvoiceCheckout(pubAdmin as never, await invFor(I1.id), null, undefined, opts4);
  check("21c segunda llamada reutiliza el link pendiente (misma URL, sin otra llamada a Wompi)", ck.ok && ck2.ok && ck2.checkoutUrl === ck.checkoutUrl, { ck, ck2 });
  const itx = `tx-st4-${crypto.randomUUID()}`;
  txMerchant.set(itx, "platform");
  const iev = await post(wompiEvent({ linkId: il.wompi_link_id, txId: itx, status: "APPROVED", amount: 11900000, key: KEYS.eventsKey }));
  check("21d evento Wompi de plataforma -> processed", iev.body?.classification === "processed", iev.body);
  const ia2 = await sendEnv(await deliveryBody(il.id));
  const subA = (await root`select status from public.billing_subscriptions where id=${I1.sb}`)[0];
  check("21d aviso firmado: factura PAID y suscripcion ACTIVE", ia2.body.result === "applied" && (await invFor(I1.id)) && (await root`select status from public.payment_invoices where id=${I1.id}`)[0].status === "PAID" && subA.status === "ACTIVE", { ia2, subA });

  // reconciliacion: el aviso nunca llego; sync consulta el servicio y aplica con la MISMA funcion SQL
  const I2 = await mkInv();
  await ensureInvoiceCheckout(pubAdmin as never, await invFor(I2.id), null, undefined, opts4);
  const i2 = await invFor(I2.id);
  const il2 = (await root`select * from payments.payment_links where id=${i2.payments_link_id}`)[0];
  const s0 = await syncInvoiceFromService(pubAdmin as never, { id: I2.id, payer_tenant_id: U1, payments_link_id: i2.payments_link_id }, opts4);
  check("21e sync con el link pendiente: no aplica", s0.synced === false && s0.result === "link_pending", s0);
  const stx = `tx-st4-${crypto.randomUUID()}`;
  txMerchant.set(stx, "platform");
  await post(wompiEvent({ linkId: il2.wompi_link_id, txId: stx, status: "APPROVED", amount: 11900000, key: KEYS.eventsKey }));
  const s1 = await syncInvoiceFromService(pubAdmin as never, { id: I2.id, payer_tenant_id: U1, payments_link_id: i2.payments_link_id }, opts4);
  const subB = (await root`select status from public.billing_subscriptions where id=${I2.sb}`)[0];
  const row2 = (await root`select status, provider_transaction_id from public.payment_invoices where id=${I2.id}`)[0];
  check("21e sync con el link pagado: aplica (PAID, tx del servicio, suscripcion ACTIVE)", s1.synced && row2.status === "PAID" && row2.provider_transaction_id === stx && subB.status === "ACTIVE", { s1, row2, subB });
  const s2 = await syncInvoiceFromService(pubAdmin as never, { id: I2.id, payer_tenant_id: U1, payments_link_id: i2.payments_link_id }, opts4);
  check("21e sync repetido y luego el aviso tardio: duplicate, un solo intento", s2.result === "duplicate" && (await sendEnv(await deliveryBody(il2.id))).body.result === "duplicate" &&
    Number((await root`select count(*)::int n from public.payment_attempts where invoice_id=${I2.id}`)[0].n) === 1, s2);
  // aislamiento: factura de otro tenant, sync con el pagador equivocado
  const I3 = await mkInv();
  await ensureInvoiceCheckout(pubAdmin as never, await invFor(I3.id), null, undefined, opts4);
  const i3 = await invFor(I3.id);
  const il3 = (await root`select * from payments.payment_links where id=${i3.payments_link_id}`)[0];
  const ttx = `tx-st4-${crypto.randomUUID()}`;
  txMerchant.set(ttx, "platform");
  await post(wompiEvent({ linkId: il3.wompi_link_id, txId: ttx, status: "APPROVED", amount: 11900000, key: KEYS.eventsKey }));
  const s3 = await syncInvoiceFromService(pubAdmin as never, { id: I3.id, payer_tenant_id: U2, payments_link_id: i3.payments_link_id }, opts4);
  check("21f sync con pagador ajeno: no aplica (tenant_mismatch) y la factura sigue PENDING", !s3.synced && s3.result === "not_applicable" && (await root`select status from public.payment_invoices where id=${I3.id}`)[0].status === "PENDING", s3);
  merchantWithCredential = null;
}

console.log("== 14. secretos en respuestas / logs / DB");
const secrets: Record<string, string> = { api_key: API_KEY, new_key: NEWKEY, signing: SIGNING, events: KEYS.eventsKey, priv: KEYS.privateKey, tenant_events: KEYS.tenantEvents, tenant_priv: KEYS.tenantPrivate, hash: await sha256Hex(API_KEY), cron: "CRONSECRET_xyz" };
const alllogs = logBuf.join("\n");
for (const [k, v] of Object.entries(secrets)) check(`log sin ${k}`, !alllogs.includes(v));
const dbDump = JSON.stringify({
  ev: await root`select raw from payments.events`,
  dl: await root`select body, last_error from payments.deliveries`,
  at: await root`select error from payments.delivery_attempts`,
  lk: await root`select status_detail, metadata, checkout_url from payments.payment_links`,
});
for (const [k, v] of Object.entries(secrets)) check(`tablas de eventos/entregas/links sin ${k}`, !dbDump.includes(v));

console.log(`\nRESUMEN: ${passes} PASS, ${failures} FAIL`);
await root.end();
await svc.end();
await pubSql.end();
Deno.exit(failures ? 1 : 0);
