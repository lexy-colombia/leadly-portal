// ST3: consumidor interno (payments-internal). Handler real con rpc falso; la
// semantica de la base (tenant ajeno, transaccion reutilizada, segundo pago,
// reentrega) se prueba con el SQL real en 18_internal_apply.sql y en la
// seccion 20 de integration_real.ts.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { createInternalHandler, extractPaymentDetails } from "../../functions/_shared/payments-service/internalConsumer.ts";
import { signEnvelope, verifyEnvelopeSignature } from "../../functions/_shared/payments-service/hmac.ts";
import { captureLogs } from "./harness.ts";

const SECRET = "whsec_internal_test_secret_0123456789";
const CLIENT_ID = "11111111-1111-4111-8111-111111111111";
const TENANT = "22222222-2222-4222-8222-222222222222";
const ORDER = "33333333-3333-4333-8333-333333333333";
const INVOICE = "44444444-4444-4444-8444-444444444444";
const LINK = "55555555-5555-4555-8555-555555555555";
const NOW_MS = 1_800_000_000_000;
const NOW_S = Math.floor(NOW_MS / 1000);

interface Call { fn: string; args: Record<string, unknown> }
function fakeRpc(over: { apply?: (c: Call) => { data?: unknown; error?: { code?: string; message: string } }; secretFails?: boolean; clientOk?: boolean } = {}) {
  const calls: Call[] = [];
  return {
    calls,
    rpc: {
      rpc(fn: string, args: Record<string, unknown> = {}) {
        calls.push({ fn, args });
        if (fn === "payments_internal_client_ok") return Promise.resolve({ data: over.clientOk ?? true, error: null });
        if (fn === "payments_read_signing_secret_name") {
          return Promise.resolve(over.secretFails ? { data: null, error: { code: "PY404", message: "x" } } : { data: "payments/clients/internal/signing", error: null });
        }
        if (fn === "payments_read_secret") return Promise.resolve({ data: SECRET, error: null });
        const r = over.apply ? over.apply({ fn, args }) : { data: { result: "applied" } };
        return Promise.resolve({ data: r.data ?? null, error: r.error ?? null });
      },
    },
  };
}

function envelope(over: Record<string, unknown> = {}, kind: "order" | "invoice" = "order") {
  const id = kind === "order" ? ORDER : INVOICE;
  return {
    id: "evt-1",
    type: "payment_link.transaction",
    created_at: "2026-10-16T12:00:00.000Z",
    payment_link: {
      id: LINK, external_reference: `${kind}:${id}`, status: "paid", amount_in_cents: 150000, currency: "COP",
      metadata: { kind, tenant_id: TENANT, [`${kind}_id`]: id },
    },
    classification: "processed",
    transaction: { id: "tx-1", status: "APPROVED", amount_in_cents: 150000, currency: "COP" },
    wompi: { data: { transaction: { id: "tx-1", status: "APPROVED", payment_method_type: "CARD", payment_method: { extra: { brand: "visa", last_four: "4242" } } } } },
    ...over,
  };
}

async function send(h: (r: Request) => Promise<Response>, body: string, opts: { t?: number; secret?: string; header?: string | null; method?: string } = {}) {
  const header = opts.header !== undefined ? opts.header : await signEnvelope(opts.secret ?? SECRET, body, opts.t ?? NOW_S);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (header !== null) headers["Payments-Signature"] = header;
  const res = await h(new Request("https://x.supabase.co/functions/v1/payments-internal", { method: opts.method ?? "POST", headers, body: opts.method === "GET" ? undefined : body }));
  return { status: res.status, body: await res.json() };
}
const mk = (rpc = fakeRpc(), clientId: string | null = CLIENT_ID) => ({ rpc, h: createInternalHandler({ rpc: rpc.rpc, now: () => NOW_MS, clientId }) });
const applyCalls = (r: { calls: Call[] }) => r.calls.filter((c) => c.fn.startsWith("apply_wompi"));

Deno.test("verifyEnvelopeSignature: valida, mal secreto, cuerpo alterado, tolerancia ±5 min, cabecera mal formada", async () => {
  const body = '{"a":1}';
  const ok = await signEnvelope(SECRET, body, NOW_S);
  assert(await verifyEnvelopeSignature(SECRET, ok, body, NOW_S));
  assert(!(await verifyEnvelopeSignature("otro", ok, body, NOW_S)));
  assert(!(await verifyEnvelopeSignature(SECRET, ok, body + " ", NOW_S)));
  const old = await signEnvelope(SECRET, body, NOW_S - 301);
  assert(!(await verifyEnvelopeSignature(SECRET, old, body, NOW_S)));
  assert(await verifyEnvelopeSignature(SECRET, await signEnvelope(SECRET, body, NOW_S - 300), body, NOW_S));
  assert(!(await verifyEnvelopeSignature(SECRET, await signEnvelope(SECRET, body, NOW_S + 301), body, NOW_S)));
  for (const bad of [null, "", "t=abc,v1=zz", `t=${NOW_S}`, `v1=${"a".repeat(64)}`, `t=${NOW_S},v1=${"a".repeat(63)}`]) {
    assert(!(await verifyEnvelopeSignature(SECRET, bad, body, NOW_S)), `rechaza ${bad}`);
  }
  // el timestamp está firmado: cambiar t con el mismo v1 falla
  const v1 = ok.split("v1=")[1];
  assert(!(await verifyEnvelopeSignature(SECRET, `t=${NOW_S + 1},v1=${v1}`, body, NOW_S)));
});

Deno.test("firma válida + pedido pagado -> aplica con los argumentos exactos (200 applied)", async () => {
  const { rpc, h } = mk();
  const r = await send(h, JSON.stringify(envelope()));
  assertEquals(r.status, 200);
  assertEquals(r.body.result, "applied");
  const [c] = applyCalls(rpc);
  assertEquals(c.fn, "apply_wompi_order_payment");
  assertEquals(c.args, {
    p_order_id: ORDER, p_tenant_id: TENANT, p_payment_link_id: LINK, p_transaction_id: "tx-1",
    p_amount_cents: 150000, p_link_amount_cents: 150000, p_currency: "COP", p_reference: "VISA ****4242",
  });
  // el secreto se lee con el id del cliente interno
  assertEquals(rpc.calls[0], { fn: "payments_internal_client_ok", args: { p_client_id: CLIENT_ID } });
  assertEquals(rpc.calls[1], { fn: "payments_read_signing_secret_name", args: { p_client_id: CLIENT_ID } });
});

Deno.test("factura de plataforma -> apply_wompi_invoice_payment con detalle de la transaccion", async () => {
  const { rpc, h } = mk();
  const r = await send(h, JSON.stringify(envelope({}, "invoice")));
  assertEquals(r.body.result, "applied");
  const [c] = applyCalls(rpc);
  assertEquals(c.fn, "apply_wompi_invoice_payment");
  assertEquals(c.args.p_invoice_id, INVOICE);
  const p = c.args.p_payment as Record<string, unknown>;
  assertEquals([p.method, p.brand, p.last_four, p.reference], ["CARD", "VISA", "4242", "VISA ****4242"]);
});

Deno.test("firma inválida (secreto, cuerpo alterado, sin cabecera, método GET) -> 401/405 sin detalle y SIN escribir", async () => {
  const { rpc, h } = mk();
  const body = JSON.stringify(envelope());
  const r1 = await send(h, body, { secret: "otro-secreto" });
  const r2 = await send(h, body.replace("150000", "1"), { header: await signEnvelope(SECRET, body, NOW_S) });
  const r3 = await send(h, body, { header: null });
  for (const r of [r1, r2, r3]) {
    assertEquals(r.status, 401);
    assertEquals(r.body, { error: { code: "invalid_signature" } });
  }
  assertEquals((await send(h, body, { method: "GET" })).status, 405);
  assertEquals(applyCalls(rpc).length, 0);
});

Deno.test("replay fuera de tolerancia -> 401; dentro de tolerancia -> aplica", async () => {
  const { rpc, h } = mk();
  const body = JSON.stringify(envelope());
  assertEquals((await send(h, body, { t: NOW_S - 400 })).status, 401);
  assertEquals((await send(h, body, { t: NOW_S + 400 })).status, 401);
  assertEquals(applyCalls(rpc).length, 0);
  assertEquals((await send(h, body, { t: NOW_S - 200 })).status, 200);
  assertEquals(applyCalls(rpc).length, 1);
});

Deno.test("cabecera sin forma t=,v1= no cuesta lecturas de Vault", async () => {
  const { rpc, h } = mk();
  assertEquals((await send(h, "{}", { header: "garbage" })).status, 401);
  assertEquals(rpc.calls.length, 0);
});

Deno.test("sin PAYMENTS_INTERNAL_CLIENT_ID o con Vault caído -> 503 (el servicio reintenta)", async () => {
  const a = mk(fakeRpc(), null);
  assertEquals((await send(a.h, "{}")).status, 503);
  const b = mk(fakeRpc({ secretFails: true }));
  assertEquals((await send(b.h, "{}")).status, 503);
});

Deno.test("eventos que no son pago aprobado -> 200 sin efecto", async () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["link pending", { payment_link: { ...envelope().payment_link, status: "pending" } }],
    ["tx DECLINED", { transaction: { ...envelope().transaction, status: "DECLINED" } }],
    ["classification amount_mismatch", { classification: "amount_mismatch" }],
    ["classification duplicate_payment", { classification: "duplicate_payment" }],
    ["tipo desconocido", { type: "otra.cosa" }],
  ];
  for (const [name, over] of cases) {
    const { rpc, h } = mk();
    const { result: r } = await captureLogs(() => send(h, JSON.stringify(envelope(over))));
    assertEquals(r.status, 200, name);
    assertEquals(r.body.result, "ignored", name);
    assertEquals(applyCalls(rpc).length, 0, name);
  }
});

Deno.test("voided -> 200, log critical y SIN reversión automática (ninguna escritura)", async () => {
  const { rpc, h } = mk();
  const ev = envelope({ payment_link: { ...envelope().payment_link, status: "voided" }, transaction: { ...envelope().transaction, status: "VOIDED" } });
  const { result: r, logs } = await captureLogs(() => send(h, JSON.stringify(ev)));
  assertEquals(r.status, 200);
  assertEquals(applyCalls(rpc).length, 0);
  assert(logs.includes('"level":"critical"') && logs.includes("payments_internal_voided"));
});

Deno.test("metadata incoherente o referencia mal formada -> 200, critical, SIN escribir", async () => {
  const base = envelope().payment_link;
  const cases: Array<[string, unknown]> = [
    ["kind distinto del prefijo", { ...base, metadata: { ...base.metadata, kind: "invoice" } }],
    ["order_id distinto de la referencia", { ...base, metadata: { ...base.metadata, order_id: INVOICE } }],
    ["sin tenant_id", { ...base, metadata: { kind: "order", order_id: ORDER } }],
    ["tenant_id no uuid", { ...base, metadata: { ...base.metadata, tenant_id: "x" } }],
    ["sin metadata", { ...base, metadata: null }],
    ["referencia sin prefijo", { ...base, external_reference: ORDER }],
    ["referencia con prefijo desconocido", { ...base, external_reference: `sale:${ORDER}` }],
    ["id de link no uuid", { ...base, id: "no-uuid" }],
  ];
  for (const [name, link] of cases) {
    const { rpc, h } = mk();
    const { result: r, logs } = await captureLogs(() => send(h, JSON.stringify(envelope({ payment_link: link }))));
    assertEquals(r.status, 200, name);
    assertEquals(r.body.reason, "inconsistent_envelope", name);
    assertEquals(applyCalls(rpc).length, 0, name);
    assert(logs.includes("payments_internal_inconsistent_envelope"), name);
  }
});

Deno.test("monto/moneda de la transacción distinto del link -> 200 amount_mismatch, sin escribir", async () => {
  for (const tx of [{ amount_in_cents: 149999 }, { currency: "USD" }]) {
    const { rpc, h } = mk();
    const { result: r } = await captureLogs(() => send(h, JSON.stringify(envelope({ transaction: { ...envelope().transaction, ...tx } }))));
    assertEquals(r.status, 200);
    assertEquals(r.body.reason, "amount_mismatch");
    assertEquals(applyCalls(rpc).length, 0);
  }
});

Deno.test("resultados de la base: duplicate -> 200 sin alerta; conflict/not_applicable -> 200 con critical", async () => {
  const dup = mk(fakeRpc({ apply: () => ({ data: { result: "duplicate" } }) }));
  const { result: d, logs: dl } = await captureLogs(() => send(dup.h, JSON.stringify(envelope())));
  assertEquals([d.status, d.body.result], [200, "duplicate"]);
  assert(!dl.includes('"level":"critical"'));
  const conf = mk(fakeRpc({ apply: () => ({ data: { result: "conflict", reason: "order_already_paid" } }) }));
  const { result: c, logs: cl } = await captureLogs(() => send(conf.h, JSON.stringify(envelope())));
  assertEquals([c.status, c.body.result, c.body.reason], [200, "conflict", "order_already_paid"]);
  assert(cl.includes("payments_internal_conflict"));
  const tm = mk(fakeRpc({ apply: () => ({ data: { result: "not_applicable", reason: "tenant_mismatch" } }) }));
  const { result: t, logs: tl } = await captureLogs(() => send(tm.h, JSON.stringify(envelope())));
  assertEquals([t.status, t.body.result], [200, "not_applicable"]);
  assert(tl.includes("payments_internal_tenant_mismatch") && tl.includes('"level":"critical"'));
});

Deno.test("error transitorio de la base (o resultado inesperado) -> 500 para que el servicio reintente", async () => {
  const e = mk(fakeRpc({ apply: () => ({ error: { code: "57P01", message: "terminating connection" } }) }));
  const { result: r1, logs } = await captureLogs(() => send(e.h, JSON.stringify(envelope())));
  assertEquals(r1.status, 500);
  assert(!JSON.stringify(r1.body).includes("terminating"));
  assert(logs.includes("payments_internal_apply_failed"));
  const u = mk(fakeRpc({ apply: () => ({ data: { nope: 1 } }) }));
  assertEquals((await captureLogs(() => send(u.h, JSON.stringify(envelope())))).result.status, 500);
});

Deno.test("cuerpo firmado pero no JSON -> 200 (reintentar no lo arregla), sin escribir", async () => {
  const { rpc, h } = mk();
  const r = (await captureLogs(() => send(h, "esto no es json"))).result;
  assertEquals(r.status, 200);
  assertEquals(applyCalls(rpc).length, 0);
});

Deno.test("extractPaymentDetails: PSE / Nequi / sin tipo", () => {
  assertEquals(extractPaymentDetails({ payment_method_type: "PSE", payment_method: { extra: { bank_name: "Banco X" } } }).reference, "PSE - Banco X");
  assertEquals(extractPaymentDetails({ payment_method_type: "NEQUI", payment_method: { phone_number: "300" } }).reference, "Nequi 300");
  assertEquals(extractPaymentDetails({}).reference, "Pago");
});

Deno.test("B1: cliente configurado no interno/suspendido/revocado/inexistente -> 503, NO se lee el secreto y NO se acredita", async () => {
  const rpc = fakeRpc({ clientOk: false });
  const h = createInternalHandler({ rpc: rpc.rpc, now: () => NOW_MS, clientId: CLIENT_ID });
  // un cliente externo firma con SU PROPIO secreto un sobre con metadata mentirosa
  const body = JSON.stringify(envelope());
  const { result: r, logs } = await captureLogs(() => send(h, body));
  assertEquals(r.status, 503);
  assertEquals(r.body, { error: { code: "not_configured" } });
  assertEquals(applyCalls(rpc).length, 0);
  assert(!rpc.calls.some((c) => c.fn === "payments_read_signing_secret_name" || c.fn === "payments_read_secret"), "no se toca el secreto");
  assert(logs.includes("payments_internal_client_invalid") && logs.includes('"level":"critical"'));
  // la guarda que falla por error de RPC tambien es 503
  const bad = mk(fakeRpc({ clientOk: false }));
  assertEquals((await captureLogs(() => send(bad.h, body))).result.status, 503);
});
