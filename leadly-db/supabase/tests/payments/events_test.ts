import { assert, assertEquals } from "jsr:@std/assert@1";
import { addClient, createOwnLink, handler, newWorld, req, SECRETS, wompiEvent } from "./harness.ts";

async function setup(opts: { callback?: string | null } = {}) {
  const w = newWorld();
  const c = await addClient(w, { callback: opts.callback });
  const h = handler(w);
  const { body, wompiLinkId } = await createOwnLink(w, h, c.apiKey);
  w.callbacks.set("https://hooks.example.com/pay", () => new Response("ok", { status: 200 }));
  return { w, h, c, link: body, wompiLinkId };
}
const post = (h: (r: Request) => Promise<Response>, payload: unknown, headers: Record<string, string> = {}) =>
  h(req("POST", "/v1/events/wompi", { body: payload, headers }));

Deno.test("evento propio aprobado: checksum válido, link pagado, aviso entregado y firmado", async () => {
  const { w, h, link, wompiLinkId, c } = await setup();
  const ev = await wompiEvent({ linkId: wompiLinkId });
  const r = await post(h, ev);
  assertEquals(r.status, 200);
  assertEquals((await r.json()).classification, "processed");
  assertEquals(w.links[0].status, "paid");
  assertEquals(w.deliveries[0].status, "delivered");
  const call = w.fetchCalls.find((x) => x.url === "https://hooks.example.com/pay")!;
  const headers = call.init.headers as Record<string, string>;
  const raw = call.init.body as string;
  const m = headers["Payments-Signature"].match(/^t=(\d+),v1=([0-9a-f]{64})$/)!;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(c.signingSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${m[1]}.${raw}`)));
  assertEquals(Array.from(mac).map((b) => b.toString(16).padStart(2, "0")).join(""), m[2]);
  assertEquals(headers["Payments-Delivery-Attempt"], "1");
  assertEquals(headers["Payments-Event-Id"], String(w.events[0].id));
  assertEquals(call.init.redirect, "manual");
  const env = JSON.parse(raw);
  assertEquals(env.type, "payment_link.transaction");
  assertEquals(env.payment_link.id, link.id);
  assertEquals(env.classification, "processed");
  assertEquals(env.wompi.data.transaction.id, "tx-1");
});

Deno.test("checksum inválido (events_key distinta): 401, se guarda invalid_signature, link sigue pendiente, sin entrega", async () => {
  const { w, h, wompiLinkId } = await setup();
  const ev = await wompiEvent({ linkId: wompiLinkId, eventsKey: "otra_clave" });
  const r = await post(h, ev);
  assertEquals(r.status, 401);
  assertEquals((await r.json()).error.code, "invalid_signature");
  assertEquals(w.events[0].classification, "invalid_signature");
  assertEquals(w.links[0].status, "pending");
  assertEquals(w.deliveries.length, 0);
});

Deno.test("checksum manipulado (monto alterado tras firmar) se rechaza", async () => {
  const { w, h, wompiLinkId } = await setup();
  const ev = await wompiEvent({ linkId: wompiLinkId });
  ev.data.transaction.amount_in_cents = 1;
  const r = await post(h, ev);
  assertEquals(r.status, 401);
  assertEquals(w.links[0].status, "pending");
});

Deno.test("evento de ambiente prod contra credencial sandbox no se puede verificar -> 401", async () => {
  const { w, h, wompiLinkId } = await setup();
  const r = await post(h, await wompiEvent({ linkId: wompiLinkId, env: "prod" }));
  assertEquals(r.status, 401);
  assertEquals(w.links[0].status, "pending");
});

Deno.test("evento de link desconocido con firma de plataforma válida: unknown_link, 200, SIN reenvío, resumen sin datos personales", async () => {
  const { w, h } = await setup();
  const ev = await wompiEvent({ linkId: "link-de-otro-tenant", txId: "tx-ajeno" });
  const r = await post(h, ev);
  assertEquals(r.status, 200);
  assertEquals((await r.json()).classification, "unknown_link");
  assertEquals(w.events[0].classification, "unknown_link");
  assert(!w.fetchCalls.some((c) => c.url.includes("payment-webhook-wompi")), "ya no se reenvía a payment-webhook-wompi");
  assertEquals(w.links[0].status, "pending");
  assertEquals(w.deliveries.length, 0);
  const stored = JSON.stringify(w.events[0].raw);
  assert(!stored.includes("persona@example.com"));
  assert(!stored.includes("signature"));
  assertEquals(w.verify.calls.length, 0);
});

Deno.test("sin oráculo de existencia: sin firma válida, link propio y link inexistente responden IGUAL (401 invalid_signature)", async () => {
  const { w, h, wompiLinkId } = await setup();
  const own = await post(h, await wompiEvent({ linkId: wompiLinkId, eventsKey: "clave_falsa" }));
  const unknown = await post(h, await wompiEvent({ linkId: "no-existe-en-ningun-lado", eventsKey: "clave_falsa" }));
  assertEquals(own.status, 401);
  assertEquals(unknown.status, 401);
  const a = (await own.json()).error;
  const b = (await unknown.json()).error;
  assertEquals([a.code, a.message], [b.code, b.message]);
  assertEquals(w.links[0].status, "pending");
});

Deno.test("evento sin payment_link_id con firma válida (pago directo del comercio): unknown_link 200", async () => {
  const { w, h } = await setup();
  const ev = await wompiEvent({ linkId: "x" });
  (ev.data.transaction as Record<string, unknown>).payment_link_id = null;
  const r = await post(h, ev);
  assertEquals(r.status, 200);
  assertEquals((await r.json()).classification, "unknown_link");
  assert(!w.fetchCalls.some((c) => c.url.includes("payment-webhook-wompi")));
});

Deno.test("duplicado (mismo transaction+status) no encola otra entrega", async () => {
  const { w, h, wompiLinkId } = await setup();
  const ev = await wompiEvent({ linkId: wompiLinkId });
  await post(h, ev);
  const r = await post(h, ev);
  assertEquals(r.status, 200);
  assertEquals((await r.json()).classification, "duplicate");
  assertEquals(w.deliveries.length, 1);
  assertEquals(w.links[0].status, "paid");
});

Deno.test("monto distinto: amount_mismatch, NO queda pagado", async () => {
  const { w, h, wompiLinkId } = await setup();
  const r = await post(h, await wompiEvent({ linkId: wompiLinkId, amount: 100 }));
  assertEquals(r.status, 200);
  assertEquals((await r.json()).classification, "amount_mismatch");
  assertEquals(w.links[0].status, "pending");
  assertEquals(w.deliveries[0].body.classification, "amount_mismatch");
});

Deno.test("moneda distinta: amount_mismatch", async () => {
  const { w, h, wompiLinkId } = await setup();
  const r = await post(h, await wompiEvent({ linkId: wompiLinkId, currency: "USD" }));
  assertEquals((await r.json()).classification, "amount_mismatch");
  assertEquals(w.links[0].status, "pending");
});

Deno.test("dos APPROVED distintas: la segunda es duplicate_payment", async () => {
  const { w, h, wompiLinkId } = await setup();
  await post(h, await wompiEvent({ linkId: wompiLinkId, txId: "tx-A" }));
  const r = await post(h, await wompiEvent({ linkId: wompiLinkId, txId: "tx-B" }));
  assertEquals((await r.json()).classification, "duplicate_payment");
  assertEquals(w.links[0].paid_transaction_id, "tx-A");
  assertEquals(w.deliveries.length, 2);
});

Deno.test("DECLINED se propaga sin cerrar el link", async () => {
  const { w, h, wompiLinkId } = await setup();
  const r = await post(h, await wompiEvent({ linkId: wompiLinkId, status: "DECLINED" }));
  assertEquals((await r.json()).classification, "processed");
  assertEquals(w.links[0].status, "pending");
});

Deno.test("JSON inválido y evento sin transacción: malformed + 200", async () => {
  const { w, h } = await setup();
  let r = await h(req("POST", "/v1/events/wompi", { raw: "{no es json" }));
  assertEquals(r.status, 200);
  assertEquals(w.events.at(-1)!.classification, "malformed");
  r = await post(h, { event: "nequi_token.updated", data: {} });
  assertEquals(r.status, 200);
  assertEquals(w.events.at(-1)!.classification, "malformed");
  assertEquals(w.fetchCalls.filter((c) => c.url.endsWith("payment-webhook-wompi")).length, 0);
});

Deno.test("sin callback_url no hay entrega; el evento igual queda registrado", async () => {
  const { w, h, wompiLinkId } = await setup({ callback: null });
  const r = await post(h, await wompiEvent({ linkId: wompiLinkId }));
  assertEquals(r.status, 200);
  assertEquals(w.deliveries.length, 0);
  assertEquals(w.links[0].status, "paid");
});

Deno.test("sin credencial de plataforma: 503 (Wompi reintenta), nada se marca pagado", async () => {
  const { w, h, wompiLinkId } = await setup();
  w.credential = null;
  const r = await post(h, await wompiEvent({ linkId: wompiLinkId }));
  assertEquals(r.status, 503);
  assertEquals(w.links[0].status, "pending");
});

Deno.test("tripwire: si P1 marcara procesado un monto distinto, se emite alerta crítica", async () => {
  const { w, h, wompiLinkId } = await setup();
  w.buggyAmount = true;
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => logs.push(a.join(" "));
  try {
    await post(h, await wompiEvent({ linkId: wompiLinkId, amount: 100 }));
  } finally {
    console.log = orig;
  }
  assert(logs.some((l) => l.includes("amount_guard_divergence")), "debe alertar la divergencia de monto");
});

Deno.test("el tripwire NO se dispara en el caso normal", async () => {
  const { w, h, wompiLinkId } = await setup();
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => logs.push(a.join(" "));
  try {
    await post(h, await wompiEvent({ linkId: wompiLinkId }));
  } finally {
    console.log = orig;
  }
  assert(!logs.some((l) => l.includes("amount_guard_divergence")));
  assert(SECRETS.eventsKey);
});
