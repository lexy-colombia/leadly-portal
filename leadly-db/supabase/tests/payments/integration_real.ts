// Prueba de INTEGRACION REAL (revision independiente): router real de P2
// (createHandler) + funciones SQL REALES de P1 (Postgres 15 descartable con la
// migracion aplicada) + Wompi / receptor / reenvio falsos por `fetch` inyectado.
// NO se llama *_test.ts a propósito: necesita Postgres, no corre con `deno test`.
// Uso:   tests/payments/run_integration.sh     (levanta un Postgres 15 descartable,
//        aplica 00_stubs.sql + la migración real y corre este script)
// Manual: DATABASE_URL=postgres://postgres@127.0.0.1:54330/rt deno run -A tests/payments/integration_real.ts
// NO toca ninguna base real. Imprime PASS/FAIL y sale con codigo != 0 si algo falla.
// Seccion 17: origenes legacy (public.payment_invoices / sales_order_payment_links) con
// legacyStore.ts REAL sobre un emulador de supabase-js en SQL real (pgSupabase.ts).
import postgres from "npm:postgres@3";
import { createHandler } from "../../functions/_shared/payments-service/router.ts";
import { sha256Hex, hmacSha256Hex } from "../../functions/_shared/payments-service/hmac.ts";
import { checkCallbackDestination } from "../../functions/_shared/payments-service/ssrf.ts";
import type { Deps, PayEnvironment, RpcClient } from "../../functions/_shared/payments-service/types.ts";
import { createLegacyStore } from "../../functions/_shared/payments-service/legacyStore.ts";
import { applyWebhookEvent } from "../../functions/_shared/payments/applyWebhookEvent.ts";
import { pgSupabase } from "./pgSupabase.ts";

const URL_DB = Deno.env.get("DATABASE_URL") ?? "postgres://postgres@127.0.0.1:54330/rt";
const root = postgres(URL_DB, { max: 4, onnotice: () => {} }); // superusuario (solo para inspeccionar / forzar tiempos)
const svc = postgres(URL_DB, { max: 12, onnotice: () => {}, connection: { options: "-c role=service_role" } });
// PostgREST devuelve numeric como numero JSON, no como string.
const legacySql = postgres(URL_DB, {
  max: 6, onnotice: () => {}, connection: { options: "-c role=service_role" },
  types: { numeric: { to: 1700, from: [1700], serialize: (x: unknown) => String(x), parse: (x: string) => Number(x) } },
});
const legacyAdmin = pgSupabase(legacySql);

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

const deps: Deps = {
  rpc: realRpc,
  fetch: fakeFetch,
  now: () => Date.now(),
  env: { supabaseUrl: "https://proj.supabase.co", cronSecret: "CRONSECRET_xyz" },
  legacy: createLegacyStore(legacyAdmin as never),
  getPlatformCredential: async () => ({
    mode: world.mode,
    getSecret: async (n) => (n === "private_key" ? KEYS.privateKey : n === "events_key" ? KEYS.eventsKey : null),
  }),
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

console.log("== 17. FUSION: origenes legacy con SQL real y legacyStore.ts real");
// --- datos: un tenant con Wompi propio (cobra a su cliente), una factura de plataforma, una factura de un tenant-merchant
const T1 = (await root`insert into public.tenants(name) values ('Tenant Uno') returning id`)[0].id as string;
const T2 = (await root`insert into public.tenants(name) values ('Tenant Dos') returning id`)[0].id as string;
const CRED = (await root`insert into public.tenant_payment_credentials(tenant_id, provider_key, mode) values (${T1}, 'wompi', 'sandbox') returning id`)[0].id as string;
await root`insert into public.test_credential_secrets values (${CRED}, 'private_key', ${KEYS.tenantPrivate}), (${CRED}, 'events_key', ${KEYS.tenantEvents})`;
let orderSeq = 0;
const mkOrder = async (tenant: string) => (await root`insert into public.sales_orders(tenant_id, number, status, total) values (${tenant}, ${++orderSeq}, 'confirmada', 1000) returning id`)[0].id as string;
const mkSub = async () => (await root`insert into public.billing_subscriptions default values returning id`)[0].id as string;
const mkInvoice = async (o: { checkout: string; cents?: number; merchant?: string | null; status?: string }) =>
  (await root`insert into public.payment_invoices(merchant_tenant_id, payer_tenant_id, subscription_id, provider_key, amount_cents, status, provider_checkout_id)
    values (${o.merchant ?? null}, ${T2}, ${await mkSub()}, 'wompi', ${o.cents ?? 250_000}, ${o.status ?? "PENDING"}, ${o.checkout}) returning id`)[0].id as string;
const mkOrderLink = async (o: { checkout: string; amount?: number; status?: string }) =>
  (await root`insert into public.sales_order_payment_links(tenant_id, order_id, provider_key, provider_checkout_id, checkout_url, amount, status)
    values (${T1}, ${await mkOrder(T1)}, 'wompi', ${o.checkout}, ${"https://checkout.wompi.co/l/" + o.checkout}, ${o.amount ?? 1500.5}, ${o.status ?? "pending"}) returning id`)[0].id as string;

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
const subStatus = async (id: string) => (await root`select status from public.billing_subscriptions where id=${id}`)[0].status as string;
const evRows = async (tx: string) => await root`select classification, origin, origin_ref, signature_valid, amount_matches, wompi_link_id, link_id from payments.events where transaction_id=${tx} order by id`;
const payRows = async (linkId: string) => await root`select * from public.sales_order_payments where payment_link_id=${linkId}`;

console.log("-- 17.1 origen (2) factura de plataforma");
const INV1 = await mkInvoice({ checkout: "winv1" });
const inv1Sub = (await invRow(INV1)).subscription_id as string;
const vc0 = world.verifyCalls.length;
const i1 = await sendEv(await lev({ link: "winv1", tx: "ti-1", amount: 250_000, merchant: "platform" }));
check("(2) APPROVED valido -> 200 legacy_invoice", i1.status === 200 && i1.body?.classification === "legacy_invoice", i1);
check("(2) factura PAID con provider_transaction_id y suscripcion ACTIVE (trigger real una vez)", (await invRow(INV1)).status === "PAID" && (await invRow(INV1)).provider_transaction_id === "ti-1" && (await subStatus(inv1Sub)) === "ACTIVE");
check("(2) confirmo con Wompi (GET /transactions) con la llave de plataforma", world.verifyCalls.length === vc0 + 1 && world.verifyCalls.at(-1)!.id === "ti-1" && world.verifyCalls.at(-1)!.auth === `Bearer ${KEYS.privateKey}`);
const e1r = (await evRows("ti-1"))[0];
check("(2) bandeja unica: payments.events con origin=legacy_invoice, origin_ref=id de factura, firma valida, monto coincide", e1r.classification === "legacy_invoice" && e1r.origin === "legacy_invoice" && e1r.origin_ref === INV1 && e1r.signature_valid === true && e1r.amount_matches === true && e1r.link_id === null, e1r);
check("(2) un payment_attempt registrado", (await root`select count(*)::int c from public.payment_attempts where invoice_id=${INV1}`)[0].c === 1);
const i1d = await sendEv(await lev({ link: "winv1", tx: "ti-1", amount: 250_000, merchant: "platform" }));
check("(2) evento duplicado -> duplicate, un solo attempt", i1d.body?.classification === "duplicate" && (await root`select count(*)::int c from public.payment_attempts where invoice_id=${INV1}`)[0].c === 1, i1d.body);
const i1x = await sendEv(await lev({ link: "winv1", tx: "ti-1b", status: "DECLINED", amount: 250_000, merchant: "platform" }));
check("(2) DECLINED tras el pago no regresa la factura", i1x.status === 200 && (await invRow(INV1)).status === "PAID" && (await root`select count(*)::int c from public.payment_attempts where invoice_id=${INV1}`)[0].c === 1);
const i1y = await sendEv(await lev({ link: "winv1", tx: "ti-1c", amount: 250_000, merchant: "platform" }));
check("(2) segunda APPROVED (otra tx) sobre factura pagada -> duplicate_payment, no acredita", i1y.body?.classification === "duplicate_payment" && (await invRow(INV1)).provider_transaction_id === "ti-1");

const INV2 = await mkInvoice({ checkout: "winv2" });
const iM = await sendEv(await lev({ link: "winv2", tx: "ti-2", amount: 249_999, merchant: "platform" }));
check("(2) monto distinto -> amount_mismatch, factura sigue PENDING, sin attempts", iM.body?.classification === "amount_mismatch" && (await invRow(INV2)).status === "PENDING" && (await root`select count(*)::int c from public.payment_attempts where invoice_id=${INV2}`)[0].c === 0, iM.body);
check("(2) amount_matches=false en la bandeja", (await evRows("ti-2"))[0].amount_matches === false);
const iC = await sendEv(await lev({ link: "winv2", tx: "ti-2c", amount: 250_000, currency: "USD", merchant: "platform" }));
check("(2) moneda distinta -> amount_mismatch", iC.body?.classification === "amount_mismatch" && (await invRow(INV2)).status === "PENDING");
const iS = await sendEv(await lev({ link: "winv2", tx: "ti-3", amount: 250_000, merchant: "platform", badKey: true }));
check("(2) firma invalida -> 401, factura intacta, invalid_signature guardado (resumen minimo)", iS.status === 401 && (await invRow(INV2)).status === "PENDING" && (await evRows("ti-3"))[0].classification === "invalid_signature", iS.status);
const iT = await sendEv(await lev({ link: "winv2", tx: "ti-3t", amount: 250_000, merchant: "tenant" })); // firmado con la llave de OTRO merchant
check("(2) evento firmado con la llave de otro merchant -> 401", iT.status === 401 && (await invRow(INV2)).status === "PENDING");
const weakI = await signed(await lev({ link: "winv2", tx: "ti-4", amount: 250_000, merchant: "platform" }));
weakI.signature.properties = ["transaction.id", "transaction.status"];
weakI.signature.checksum = await sha256Hex("ti-4APPROVED" + String(weakI.timestamp) + KEYS.eventsKey);
const iW = await call("POST", "/v1/events/wompi", { raw: JSON.stringify(weakI) });
check("(2) signature.properties sin monto -> 401 aunque el hash cuadre", iW.status === 401 && (await invRow(INV2)).status === "PENDING", iW.status);
world.verifyMode = "down";
const iD = await sendEv(await lev({ link: "winv2", tx: "ti-5", amount: 250_000, merchant: "platform" }));
check("(2) Wompi caido -> 503, unverified, factura PENDING", iD.status === 503 && (await invRow(INV2)).status === "PENDING" && (await evRows("ti-5"))[0].classification === "unverified", iD.status);
world.verifyMode = "echo";
const iD2 = await sendEv(await lev({ link: "winv2", tx: "ti-5", amount: 250_000, merchant: "platform" }));
check("(2) reintento tras la caida SI procesa", iD2.status === 200 && iD2.body?.classification === "legacy_invoice" && (await invRow(INV2)).status === "PAID", iD2.body);

const INV3 = await mkInvoice({ checkout: "winv3", merchant: T1 }); // factura cuyo merchant es un tenant
const i3 = await sendEv(await lev({ link: "winv3", tx: "ti-6", amount: 250_000, merchant: "tenant" }));
check("(2) factura con merchant_tenant_id usa la credencial de ESE tenant", i3.body?.classification === "legacy_invoice" && (await invRow(INV3)).status === "PAID" && world.verifyCalls.at(-1)!.auth === `Bearer ${KEYS.tenantPrivate}`, i3.body);
const INV4 = await mkInvoice({ checkout: "winv4", status: "CANCELLED" });
const iN = await sendEv(await lev({ link: "winv4", tx: "ti-7", amount: 250_000, merchant: "platform" }));
check("(2) APPROVED sobre factura CANCELLED -> legacy_not_applied (dinero sin acreditar, visible), nada cambia", iN.body?.classification === "legacy_not_applied" && (await invRow(INV4)).status === "CANCELLED", iN.body);

console.log("-- 17.2 origen (3) link de pedido de un tenant");
const OL1 = await mkOrderLink({ checkout: "word1", amount: 1500.5 });
const vc1 = world.verifyCalls.length;
const o1 = await sendEv(await lev({ link: "word1", tx: "to-1", amount: 150_050, merchant: "tenant" }));
check("(3) APPROVED valido -> 200 legacy_order_payment", o1.status === 200 && o1.body?.classification === "legacy_order_payment", o1);
const op1 = await payRows(OL1);
check("(3) pago registrado: method wompi, monto = cents/100, provider_transaction_id, link paid", op1.length === 1 && op1[0].method === "wompi" && Number(op1[0].amount) === 1500.5 && op1[0].provider_transaction_id === "to-1" && (await root`select status from public.sales_order_payment_links where id=${OL1}`)[0].status === "paid", op1);
check("(3) confirmo con la llave PRIVADA DEL TENANT", world.verifyCalls.length === vc1 + 1 && world.verifyCalls.at(-1)!.auth === `Bearer ${KEYS.tenantPrivate}`);
const e3r = (await evRows("to-1"))[0];
check("(3) bandeja unica con origin=legacy_order y origin_ref=id del link", e3r.classification === "legacy_order_payment" && e3r.origin === "legacy_order" && e3r.origin_ref === OL1 && e3r.amount_matches === true, e3r);
const o1d = await sendEv(await lev({ link: "word1", tx: "to-1", amount: 150_050, merchant: "tenant" }));
check("(3) duplicado -> duplicate, un solo pago", o1d.body?.classification === "duplicate" && (await payRows(OL1)).length === 1, o1d.body);
const o1x = await sendEv(await lev({ link: "word1", tx: "to-1x", status: "DECLINED", amount: 150_050, merchant: "tenant" }));
check("(3) DECLINED tras el pago no cambia nada", o1x.status === 200 && (await payRows(OL1)).length === 1);
const o1y = await sendEv(await lev({ link: "word1", tx: "to-1y", amount: 150_050, merchant: "tenant" }));
check("(3) segunda APPROVED (otra tx) sobre link pagado -> duplicate_payment, no acredita", o1y.body?.classification === "duplicate_payment" && (await payRows(OL1)).length === 1);

const OL2 = await mkOrderLink({ checkout: "word2", amount: 1500.5 });
const oM = await sendEv(await lev({ link: "word2", tx: "to-2", amount: 100, merchant: "tenant" }));
check("(3) monto distinto -> amount_mismatch, NO se paga, link pending", oM.body?.classification === "amount_mismatch" && (await payRows(OL2)).length === 0 && (await root`select status from public.sales_order_payment_links where id=${OL2}`)[0].status === "pending", oM.body);
const oS = await sendEv(await lev({ link: "word2", tx: "to-3", amount: 150_050, merchant: "tenant", badKey: true }));
check("(3) firma invalida -> 401, sin pago", oS.status === 401 && (await payRows(OL2)).length === 0);
const oP = await sendEv(await lev({ link: "word2", tx: "to-3p", amount: 150_050, merchant: "platform" })); // llave de plataforma sobre un link de tenant
check("(3) evento firmado con la llave de PLATAFORMA sobre un link de tenant -> 401", oP.status === 401 && (await payRows(OL2)).length === 0);
const weakO = await signed(await lev({ link: "word2", tx: "to-4", amount: 150_050, merchant: "tenant" }));
weakO.signature.properties = ["transaction.id", "transaction.status"];
weakO.signature.checksum = await sha256Hex("to-4APPROVED" + String(weakO.timestamp) + KEYS.tenantEvents);
const oW = await call("POST", "/v1/events/wompi", { raw: JSON.stringify(weakO) });
check("(3) signature.properties sin monto -> 401", oW.status === 401 && (await payRows(OL2)).length === 0);
world.verifyMode = "down";
const oD = await sendEv(await lev({ link: "word2", tx: "to-5", amount: 150_050, merchant: "tenant" }));
check("(3) Wompi caido -> 503, unverified, sin pago", oD.status === 503 && (await payRows(OL2)).length === 0 && (await evRows("to-5"))[0].classification === "unverified", oD.status);
world.verifyMode = "echo";
const oD2 = await sendEv(await lev({ link: "word2", tx: "to-5", amount: 150_050, merchant: "tenant" }));
check("(3) reintento tras la caida SI procesa y paga", oD2.status === 200 && oD2.body?.classification === "legacy_order_payment" && (await payRows(OL2)).length === 1, oD2.body);

const OL3 = await mkOrderLink({ checkout: "word3", amount: 1500.5 });
// la transaccion real pertenece a OTRO link; el cuerpo se reenvia con el payment_link_id de OL3 y la firma recalculada
const oV = await sendEv(await lev({ link: "word3", tx: "to-6", amount: 150_050, merchant: "tenant", realLink: "otro_link_real" }));
check("(3) Wompi dice que la tx es de otro link -> verification_mismatch, sin pago", oV.body?.classification === "verification_mismatch" && (await payRows(OL3)).length === 0, oV.body);
world.verifyMode = "notfound";
const oN = await sendEv(await lev({ link: "word3", tx: "to-7", amount: 150_050, merchant: "tenant" }));
check("(3) Wompi 404 -> verification_mismatch, sin pago", oN.body?.classification === "verification_mismatch" && (await payRows(OL3)).length === 0, oN.body);
world.verifyMode = "echo";
const OL4 = await mkOrderLink({ checkout: "word4", amount: 1500.5, status: "expired" });
const oX = await sendEv(await lev({ link: "word4", tx: "to-8", amount: 150_050, merchant: "tenant" }));
check("(3) link expired + APPROVED -> legacy_not_applied (visible), sin pago", oX.body?.classification === "legacy_not_applied" && (await payRows(OL4)).length === 0, oX.body);
const oDA = await sendEv(await lev({ link: "word3", tx: "to-9a", status: "DECLINED", amount: 150_050, merchant: "tenant" }));
const oDB = await sendEv(await lev({ link: "word3", tx: "to-9b", amount: 150_050, merchant: "tenant" }));
check("(3) DECLINED y luego APPROVED -> termina pagado", oDA.status === 200 && oDB.body?.classification === "legacy_order_payment" && (await payRows(OL3)).length === 1);

console.log("-- 17.3 replay entre origenes y anti-replay en tablas legacy");
const INV5 = await mkInvoice({ checkout: "winv5" });
const OL5 = await mkOrderLink({ checkout: "word5", amount: 2500 });
const own5 = await call("POST", "/v1/payment-links", { headers: { authorization: `Bearer ${NEWKEY}`, "idempotency-key": "x-leg-5" }, json: mkBody({ external_reference: "LEG-5", amount_in_cents: 250_000 }) });
const W5 = String(own5.body.checkout_url).split("/").pop()!;
const pay5 = await sendEv(await lev({ link: "winv5", tx: "tx-CROSS", amount: 250_000, merchant: "platform" }));
check("(2) pago legitimo de la factura 5", pay5.body?.classification === "legacy_invoice");
// mismo cuerpo, otro payment_link_id: hacia el link de pedido (tenant) y hacia el link del servicio nuevo (plataforma)
const toOrder = await sendEv(await lev({ link: "word5", tx: "tx-CROSS", amount: 250_000, merchant: "tenant", realLink: "winv5" }));
check("[DINERO] la tx aplicada a la factura NO acredita el link de pedido", toOrder.body?.classification === "transaction_conflict" && (await payRows(OL5)).length === 0, toOrder.body);
const toOwn = await sendEv(await lev({ link: W5, tx: "tx-CROSS", amount: 250_000, merchant: "platform", realLink: "winv5" }));
check("[DINERO] ...ni el link del servicio nuevo (replay cruzado B1 extendido)", toOwn.body?.classification === "transaction_conflict" && (await dbLink(own5.body.id)).status === "pending", toOwn.body);
// al reves: tx aplicada a un link de pedido -> hacia una factura
const OL6 = await mkOrderLink({ checkout: "word6", amount: 1500.5 });
const INV6 = await mkInvoice({ checkout: "winv6", cents: 150_050 });
await sendEv(await lev({ link: "word6", tx: "tx-CROSS2", amount: 150_050, merchant: "tenant" }));
const toInv = await sendEv(await lev({ link: "winv6", tx: "tx-CROSS2", amount: 150_050, merchant: "platform", realLink: "word6" }));
check("[DINERO] la tx aplicada a un pago de pedido NO acredita una factura", toInv.body?.classification === "transaction_conflict" && (await invRow(INV6)).status === "PENDING", toInv.body);
// sin ningun evento previo: la transaccion solo vive en la tabla legacy (pago registrado a mano / por el webhook viejo)
const OL7 = await mkOrderLink({ checkout: "word7", amount: 1500.5 });
const OL8 = await mkOrderLink({ checkout: "word8", amount: 1500.5 });
await root`insert into public.sales_order_payments(tenant_id, order_id, method, amount, provider_key, provider_transaction_id, payment_link_id)
  select tenant_id, order_id, 'wompi', 1500.5, 'wompi', 'tx-OLDWEBHOOK', id from public.sales_order_payment_links where id=${OL7}`;
await root`update public.sales_order_payment_links set status='paid' where id=${OL7}`;
const toLegacyOnly = await sendEv(await lev({ link: "word8", tx: "tx-OLDWEBHOOK", amount: 150_050, merchant: "tenant", realLink: "word7" }));
check("[DINERO] tx ya acreditada por el webhook VIEJO (solo en sales_order_payments) tampoco acredita otro link", toLegacyOnly.body?.classification === "transaction_conflict" && (await payRows(OL8)).length === 0, toLegacyOnly.body);
const reOld = await sendEv(await lev({ link: "word7", tx: "tx-OLDWEBHOOK", amount: 150_050, merchant: "tenant" }));
check("reentrega de Wompi de esa misma tx al MISMO link (ya aplicada por el webhook viejo) -> duplicate, sin segundo pago", reOld.body?.classification === "duplicate" && (await payRows(OL7)).length === 1, reOld.body);

console.log("-- 17.4 compatibilidad de los otros callers y concurrencia");
const INV7 = await mkInvoice({ checkout: "winv7" });
const compat = await applyWebhookEvent(legacyAdmin as never, "wompi", {
  providerCheckoutId: "winv7", providerTransactionId: "ts-sync", status: "APPROVED", approved: true, amountCents: 250_000, currency: "COP",
  paymentMethod: "CARD", paymentBrand: null, paymentLastFour: null, paymentBank: null, paymentReference: "r", rawData: {},
});
check("applyWebhookEvent (sync-payment-invoices) conserva su contrato: PAID y handled", compat.handled === true && (await invRow(INV7)).status === "PAID");
const compat2 = await applyWebhookEvent(legacyAdmin as never, "wompi", {
  providerCheckoutId: "winv7", providerTransactionId: "ts-sync2", status: "APPROVED", approved: true, amountCents: 250_000, currency: "COP",
  paymentMethod: "CARD", paymentBrand: null, paymentLastFour: null, paymentBank: null, paymentReference: "r", rawData: {},
});
check("applyWebhookEvent idempotente: sobre factura PAID no hace nada", compat2.handled === false);

const OLC = await mkOrderLink({ checkout: "wordc", amount: 1500.5 });
const evC = await lev({ link: "wordc", tx: "to-conc", amount: 150_050, merchant: "tenant" });
const burst = await Promise.all(Array.from({ length: 6 }, () => sendEv(JSON.parse(JSON.stringify(evC)))));
check("(3) 6 entregas simultaneas del mismo evento: ninguna 5xx", burst.every((r) => r.status === 200), burst.map((r) => r.status));
check("(3) ...y exactamente UN pago registrado", (await payRows(OLC)).length === 1, (await payRows(OLC)).length);
const INVC = await mkInvoice({ checkout: "winvc" });
const evI = await lev({ link: "winvc", tx: "ti-conc", amount: 250_000, merchant: "platform" });
const burstI = await Promise.all(Array.from({ length: 6 }, () => sendEv(JSON.parse(JSON.stringify(evI)))));
check("(2) 6 entregas simultaneas: ninguna 5xx y factura PAID con una sola tx", burstI.every((r) => r.status === 200) && (await invRow(INVC)).status === "PAID");
check("(2) ...un solo payment_attempt y el resto clasificado duplicate", (await root`select count(*)::int c from public.payment_attempts where invoice_id=${INVC}`)[0].c === 1 && burstI.filter((r) => r.body?.classification === "legacy_invoice").length === 1 && burstI.filter((r) => r.body?.classification === "duplicate").length === 5, burstI.map((r) => r.body?.classification));
console.log(`INFO (2) concurrencia: payment_attempts de la factura = ${(await root`select count(*)::int c from public.payment_attempts where invoice_id=${INVC}`)[0].c} (esperado 1: la transicion a PAID es atomica)`);


console.log("-- 17.6 ronda 2: anti-llenado, credencial de tenant, ambiguo, borrado, indice por nombre de constraint");
{
  const lF = await call("POST", "/v1/payment-links", { headers: { authorization: `Bearer ${NEWKEY}`, "idempotency-key": "r3-F" }, json: mkBody({ external_reference: "R3-F" }) });
  const wF = String(lF.body.checkout_url).split("/").pop()!;
  const flood = async (i: number) => {
    const e = wompiEvent({ linkId: wF, txId: `tfl-${i}`, status: "APPROVED", amount: 5_000_000, key: "clave_falsa" });
    e.data.transaction.customer_email = "victima@example.com";
    e.data.transaction.blob = "z".repeat(200_000);
    return call("POST", "/v1/events/wompi", { raw: JSON.stringify(await signed(e)) });
  };
  const batch: Any[] = [];
  for (let i = 0; i < 200; i += 20) batch.push(...(await Promise.all(Array.from({ length: 20 }, (_, k) => flood(i + k)))));
  check("200 firmas invalidas: todas 401 (misma respuesta, sin 5xx)", batch.every((r) => r.status === 401 && r.body?.error?.code === "invalid_signature"), [...new Set(batch.map((r) => r.status))]);
  const fr = await root`select count(*)::int c, coalesce(max(octet_length(raw::text)),0)::int sz from payments.events where classification='invalid_signature' and wompi_link_id=${wF}`;
  console.log(`INFO ráfaga de 200 invalidas -> filas insertadas=${fr[0].c}, fila mayor=${fr[0].sz} bytes`);
  check("filas insertadas acotadas (<= 10 por minuto por link)", fr[0].c >= 1 && fr[0].c <= 10, fr[0]);
  check("tamaño de cada fila <= 3 KB (resumen mínimo, sin el payload de 200 KB ni el correo)", fr[0].sz <= 3000, fr[0]);
  check("ninguna fila guarda el customer_email", (await root`select count(*)::int c from payments.events where wompi_link_id=${wF} and raw::text like '%victima@example.com%'`)[0].c === 0);
  const okF = await sendEv(await lev({ link: wF, tx: "tfl-ok", amount: 5_000_000, merchant: "platform" }));
  check("el evento VÁLIDO posterior del link spameado SIGUE procesándose (paid)", okF.status === 200 && okF.body?.classification === "processed" && (await dbLink(lF.body.id)).status === "paid", okF.body);
  const ill = await call("POST", "/v1/events/wompi", { raw: JSON.stringify({ data: { transaction: { id: "q", status: "APPROVED", payment_link_id: "wompi_xx" } }, signature: { checksum: "zz", properties: [] } }) });
  check("checksum no-hex -> 401 uniforme", ill.status === 401 && ill.body?.error?.code === "invalid_signature");

  // credencial de TENANT no resoluble -> 401 (mismo cuerpo que firma inválida); plataforma ausente -> 503 (unit)
  const T3 = (await root`insert into public.tenants(name) values ('Tenant sin credencial') returning id`)[0].id as string;
  const ord3 = (await root`insert into public.sales_orders(tenant_id, number, status, total) values (${T3}, 999, 'confirmada', 1) returning id`)[0].id as string;
  await root`insert into public.sales_order_payment_links(tenant_id, order_id, provider_key, provider_checkout_id, checkout_url, amount) values (${T3}, ${ord3}, 'wompi', 'wnocred', 'https://x', 10)`;
  const nc = await sendEv(await lev({ link: "wnocred", tx: "tnc-1", amount: 1000, merchant: "tenant" }));
  const bs = await sendEv(await lev({ link: "no_existe_en_nada", tx: "tnc-2", amount: 1000, merchant: "tenant", badKey: true }));
  check("(3) tenant SIN credencial activa -> 401 invalid_signature, idéntico a una firma inválida", nc.status === 401 && bs.status === 401 && nc.body?.error?.code === bs.body?.error?.code && nc.body?.error?.message === bs.body?.error?.message, { nc: nc.status, bs: bs.status });
  check("...y nada se acreditó", (await root`select count(*)::int c from public.sales_order_payments where provider_transaction_id='tnc-1'`)[0].c === 0);

  // checkout ambiguo: dos facturas con el mismo provider_checkout_id
  await mkInvoice({ checkout: "wamb" }); await mkInvoice({ checkout: "wamb" });
  const am = await sendEv(await lev({ link: "wamb", tx: "tam-1", amount: 250_000, merchant: "platform" }));
  check("ambiguo + firma de plataforma válida -> legacy_not_applied (visible), nada pagado", am.status === 200 && am.body?.classification === "legacy_not_applied" && (await root`select count(*)::int c from public.payment_invoices where provider_checkout_id='wamb' and status='PAID'`)[0].c === 0, am.body);
  check("ambiguo: origin_ref explícito en la bandeja", (await root`select origin_ref from payments.events where transaction_id='tam-1'`)[0].origin_ref === "ambiguous:wamb");

  // factura soft-deleted
  const invDel = await mkInvoice({ checkout: "wdel" });
  await root`update public.payment_invoices set deleted_at = now() where id=${invDel}`;
  const dl = await sendEv(await lev({ link: "wdel", tx: "tdl-1", amount: 250_000, merchant: "platform" }));
  check("factura soft-deleted + APPROVED -> legacy_not_applied, sigue PENDING", dl.body?.classification === "legacy_not_applied" && (await invRow(invDel)).status === "PENDING", dl.body);

  // health: ahora cuenta legacy_not_applied
  const rdH = await call("GET", "/admin/readiness", { headers: { authorization: "Bearer x" } });
  check("health.legacy_not_applied visible en /admin/readiness", rdH.body?.health && rdH.body.health.legacy_not_applied >= 2, rdH.body?.health);

  // índice único propuesto: el 23505 por NOMBRE de constraint
  const idxSql = await Deno.readTextFile(new URL("../../../../progress/pendiente_no_aplicar/20261011210100_payment_transaction_unique_indexes.sql", import.meta.url));
  await root.unsafe(idxSql);
  const { applySalesOrderPaymentWebhookEvent } = await import("../../functions/_shared/payments/salesOrderPayments.ts");
  const L1 = await mkOrderLink({ checkout: "widx1", amount: 10 });
  const L2 = await mkOrderLink({ checkout: "widx2", amount: 10 });
  const ev = (tx: string) => ({ approved: true, providerTransactionId: tx, amountCents: 1000, paymentReference: "r" });
  const a1 = await applySalesOrderPaymentWebhookEvent(legacyAdmin as never, "wompi", "widx1", ev("tx-IDX"));
  let thrown = "";
  try { await applySalesOrderPaymentWebhookEvent(legacyAdmin as never, "wompi", "widx2", ev("tx-IDX")); } catch (e) { thrown = (e as Error).message; }
  check("índice nuevo: misma tx en OTRO link -> lanza (conflicto real), NO 'ya manejado'", a1.handled && thrown === "transaction_already_applied_to_another_payment" && (await payRows(L2)).length === 0, thrown);
  await root`update public.sales_order_payment_links set status='pending' where id=${L1}`;
  const again = await applySalesOrderPaymentWebhookEvent(legacyAdmin as never, "wompi", "widx1", ev("tx-IDX"));
  check("índice payment_link_idx: reentrega al MISMO link sigue siendo 'ya manejado'", again.handled === true && (await payRows(L1)).length === 1);
  await root`drop index if exists public.sales_order_payments_wompi_transaction_uidx`;
  await root`drop index if exists public.payment_invoices_provider_transaction_uidx`;
}

console.log("-- 17.5 trazabilidad y no-regresion");
const byClass = await root`select classification, count(*)::int c from payments.events where origin is not null or classification='unknown_link' group by 1 order by 1`;
console.log(`INFO bandeja unica, eventos legacy por clasificacion: ${JSON.stringify(byClass)}`);
check("todo evento legacy quedo en payments.events con origin y origin_ref", (await root`select count(*)::int c from payments.events where origin is not null and origin_ref is null`)[0].c === 0);
check("ningun payment_link del servicio nuevo fue tocado por eventos legacy", (await root`select count(*)::int c from payments.payment_links where status='paid' and paid_transaction_id like 'ti-%'`)[0].c === 0);
check("las filas de invalid_signature legacy guardan solo el resumen minimo (sin customer_email)", (await root`select count(*)::int c from payments.events where origin is not null and classification='invalid_signature' and raw::text like '%pagador@x.co%'`)[0].c === 0);

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

const INV18 = await mkInvoice({ checkout: "wret-inv" });
const pi = await pubStatus(INV18);
check("18b factura de plataforma PENDING -> pending", pi.status === 200 && pi.body.status === "pending" && Object.keys(pi.body).sort().join() === KEYS18.join(), pi.body);
await sendEv(await lev({ link: "wret-inv", tx: "tr-i1", status: "DECLINED", amount: 250_000, merchant: "platform" }));
check("18b factura: DECLINED -> last_attempt DECLINED (desde payments.events por origin_ref)", (await pubStatus(INV18)).body.last_attempt === "DECLINED");
await sendEv(await lev({ link: "wret-inv", tx: "tr-i2", amount: 250_000, merchant: "platform" }));
const pi2 = await pubStatus(INV18);
check("18b factura pagada -> paid / APPROVED", pi2.body.status === "paid" && pi2.body.last_attempt === "APPROVED", pi2.body);
await root`update public.payment_invoices set status='REFUNDED' where id=${INV18}`;
check("18b factura REFUNDED -> voided", (await pubStatus(INV18)).body.status === "voided");
const INV18d = await mkInvoice({ checkout: "wret-del" });
await root`update public.payment_invoices set deleted_at = now() where id=${INV18d}`;
check("18b factura soft-deleted -> unknown (igual que inexistente)", JSON.stringify((await pubStatus(INV18d)).body) === JSON.stringify({ status: "unknown", last_attempt: null, updated_at: null }));

const OL18 = await mkOrderLink({ checkout: "wret-ol", amount: 1500.5 });
check("18b link de pedido pending", (await pubStatus(OL18)).body.status === "pending");
await sendEv(await lev({ link: "wret-ol", tx: "tr-o1", amount: 150_050, merchant: "tenant" }));
const po = await pubStatus(OL18);
check("18b link de pedido pagado -> paid / APPROVED", po.body.status === "paid" && po.body.last_attempt === "APPROVED", po.body);
await root`update public.sales_order_payment_links set status='expired' where id=${OL18}`;
check("18b link de pedido expired", (await pubStatus(OL18)).body.status === "expired");

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

// (d) createSalesOrderPaymentLink real (legacy): default y explicito
{
  const { createSalesOrderPaymentLink } = await import("../../functions/_shared/payments/salesOrderPayments.ts");
  const realFetch = globalThis.fetch;
  const seen: Array<Record<string, unknown>> = [];
  let n = 0;
  globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
    if (String(input).endsWith("/payment_links")) {
      seen.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ data: { id: `wlret${++n}` } }), { status: 201 });
    }
    return realFetch(input as never, init);
  }) as typeof fetch;
  try {
    const o1 = await mkOrder(T1);
    const o2 = await mkOrder(T1);
    const a = await createSalesOrderPaymentLink(legacyAdmin as never, T1, o1, null);
    const rowA = (await root`select id, status from public.sales_order_payment_links where order_id=${o1}`)[0];
    check("18d link de pedido sin redirect: default con el id de la fila insertada", seen[0]?.redirect_url === `https://leadly.lexycolombia.com/pago/resultado?link=${rowA.id}` && a.checkoutUrl.endsWith("wlret1"), seen[0]);
    const b = await createSalesOrderPaymentLink(legacyAdmin as never, T1, o2, null, "https://tienda.example.com/tienda/x/carrito?payment=return");
    check("18d redirect explicito (tienda publica) intacto", seen[1]?.redirect_url === "https://tienda.example.com/tienda/x/carrito?payment=return" && b.checkoutUrl.endsWith("wlret2"), seen[1]);
    check("18d el endpoint publico resuelve ese id nuevo (pending)", (await pubStatus(rowA.id)).body.status === "pending");
  } finally {
    globalThis.fetch = realFetch;
  }
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
await legacySql.end();
Deno.exit(failures ? 1 : 0);
