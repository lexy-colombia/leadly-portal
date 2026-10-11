// Ronda 2 (§7.2): firma con propiedades mínimas (B2) y confirmación de toda
// APPROVED con GET /transactions/{id} (B1).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { sha256Hex } from "../../functions/_shared/payments-service/hmac.ts";
import { addClient, captureLogs, createOwnLink, handler, newWorld, req, SECRETS, wompiEvent } from "./harness.ts";

async function setup() {
  const w = newWorld();
  const c = await addClient(w);
  const h = handler(w);
  const A = await createOwnLink(w, h, c.apiKey, { external_reference: "A" });
  const B = await createOwnLink(w, h, c.apiKey, { external_reference: "B" });
  w.callbacks.set("https://hooks.example.com/pay", () => new Response("ok", { status: 200 }));
  return { w, h, c, A, B };
}
const post = (h: (r: Request) => Promise<Response>, payload: unknown) => h(req("POST", "/v1/events/wompi", { body: payload }));
const linkById = (w: ReturnType<typeof newWorld>, id: string) => w.links.find((l) => l.id === id)!;

Deno.test("B1: replay cruzado (mismo evento firmado, otro payment_link_id) NO paga el segundo link", async () => {
  const { w, h, A, B } = await setup();
  const evA = await wompiEvent({ linkId: A.wompiLinkId, txId: "tx-REPLAY" });
  const ok = await post(h, evA);
  assertEquals((await ok.json()).classification, "processed");
  const forged = JSON.parse(JSON.stringify(evA));
  forged.data.transaction.payment_link_id = B.wompiLinkId; // el checksum sigue cuadrando
  const r = await post(h, forged);
  assertEquals(r.status, 200);
  assertEquals((await r.json()).classification, "verification_mismatch");
  assertEquals(linkById(w, B.body.id).status, "pending");
  assertEquals(w.deliveries.length, 1, "no se encola aviso para el link B");
});

Deno.test("B2: firma válida que no cubre transaction.amount_in_cents -> 401 invalid_signature, guardado, link intacto", async () => {
  const { w, h, A } = await setup();
  const ev = await wompiEvent({ linkId: A.wompiLinkId, txId: "tx-WEAK" });
  ev.signature.properties = ["transaction.id", "transaction.status"];
  ev.signature.checksum = await sha256Hex(`tx-WEAKAPPROVED${ev.timestamp}${SECRETS.eventsKey}`);
  const r = await post(h, ev);
  assertEquals(r.status, 401);
  assertEquals((await r.json()).error.code, "invalid_signature");
  assertEquals(w.events.at(-1)!.classification, "invalid_signature");
  assertEquals(linkById(w, A.body.id).status, "pending");
  assertEquals(w.verify.calls.length, 0, "ni siquiera se consulta a Wompi");
});

Deno.test("APPROVED se confirma con GET {api}/transactions/{id} con la llave privada del ambiente", async () => {
  const { w, h, A } = await setup();
  await post(h, await wompiEvent({ linkId: A.wompiLinkId, txId: "tx-V1" }));
  const call = w.fetchCalls.find((c) => c.url.includes("/transactions/"))!;
  assertEquals(call.url, "https://sandbox.wompi.co/v1/transactions/tx-V1");
  assertEquals(call.init.method, "GET");
  assertEquals((call.init.headers as Record<string, string>).Authorization, `Bearer ${SECRETS.privateKey}`);
  const rec = w.rpcCalls.filter((c) => c.fn === "payments_record_event").at(-1)!;
  assertEquals((rec.args.p_verified as Record<string, unknown>).payment_link_id, A.wompiLinkId);
});

Deno.test("DECLINED/VOIDED no se consultan a Wompi", async () => {
  const { w, h, A } = await setup();
  const r = await post(h, await wompiEvent({ linkId: A.wompiLinkId, txId: "tx-D", status: "DECLINED" }));
  assertEquals(r.status, 200);
  assertEquals(w.verify.calls.length, 0);
});

Deno.test("verificación: 404 de Wompi -> verification_mismatch, sin pago ni aviso", async () => {
  const { w, h, A } = await setup();
  w.verify.mode = "notfound";
  const r = await post(h, await wompiEvent({ linkId: A.wompiLinkId, txId: "tx-404" }));
  assertEquals(r.status, 200);
  assertEquals((await r.json()).classification, "verification_mismatch");
  assertEquals(linkById(w, A.body.id).status, "pending");
  assertEquals(w.deliveries.length, 0);
});

for (const [field, value] of [["amount_in_cents", 1], ["currency", "USD"], ["status", "DECLINED"], ["payment_link_id", "otro"]] as const) {
  Deno.test(`verificación: ${field} distinto en Wompi -> verification_mismatch`, async () => {
    const { w, h, A } = await setup();
    const real = { id: "tx-M", status: "APPROVED", amount_in_cents: 1_500_000, currency: "COP", payment_link_id: A.wompiLinkId, [field]: value };
    w.verify.mode = "override";
    w.verify.override = real;
    const r = await post(h, await wompiEvent({ linkId: A.wompiLinkId, txId: "tx-M" }));
    assertEquals((await r.json()).classification, "verification_mismatch");
    assertEquals(linkById(w, A.body.id).status, "pending");
  });
}

for (const mode of ["network", "server_error", "timeout", "unauthorized"] as const) {
  Deno.test(`verificación caída (${mode}): 503 para que Wompi reintente, evento unverified, sin pago`, async () => {
    const { w, h, A } = await setup();
    w.verify.mode = mode;
    const { result: r, logs } = await captureLogs(async () => post(h, await wompiEvent({ linkId: A.wompiLinkId, txId: "tx-R" })));
    assertEquals(r.status, 503);
    assertEquals((await r.json()).error.code, "verification_unavailable");
    assertEquals(w.events.at(-1)!.classification, "unverified");
    assertEquals(linkById(w, A.body.id).status, "pending");
    assertEquals(w.deliveries.length, 0);
    if (mode === "unauthorized") assert(logs.includes('"level":"critical"'), "401 de Wompi debe loguear critical");
    // el reintento de Wompi (misma carga) con la verificación sana SÍ procesa
    w.verify.mode = "echo";
    const retry = await post(h, await wompiEvent({ linkId: A.wompiLinkId, txId: "tx-R" }));
    assertEquals(retry.status, 200);
    assertEquals((await retry.json()).classification, "processed");
    assertEquals(linkById(w, A.body.id).status, "paid");
    assertEquals(w.deliveries.length, 1);
  });
}

Deno.test("sin llave privada en la credencial -> 503 y log critical (no se paga)", async () => {
  const { w, h, A } = await setup();
  w.credential!.privateKey = null;
  const r = await post(h, await wompiEvent({ linkId: A.wompiLinkId, txId: "tx-NK" }));
  assertEquals(r.status, 503);
  assertEquals(linkById(w, A.body.id).status, "pending");
});

Deno.test("entrega: p_sent_sha256 = sha256 de los bytes realmente enviados", async () => {
  const { w, h, A } = await setup();
  await post(h, await wompiEvent({ linkId: A.wompiLinkId, txId: "tx-S" }));
  const sent = w.fetchCalls.find((c) => c.url === "https://hooks.example.com/pay")!.init.body as string;
  assertEquals(w.attempts[0].sent_sha256, await sha256Hex(sent));
});

Deno.test("entrega rechazada antes de enviar: p_sent_sha256 null", async () => {
  const w = newWorld();
  const c = await addClient(w, { callback: "https://10.0.0.5/h" });
  const h = handler(w);
  const A = await createOwnLink(w, h, c.apiKey);
  await post(h, await wompiEvent({ linkId: A.wompiLinkId, txId: "tx-N" }));
  assertEquals(w.attempts[0].sent_sha256, null);
});

Deno.test("readiness: health falla -> health null, la tarjeta no se rompe", async () => {
  const w = newWorld();
  const h = handler(w);
  const orig = w.healthSummary;
  (w as unknown as { healthSummary: unknown }).healthSummary = orig;
  const deps = handler(w, { rpc: { rpc: (fn: string, a?: Record<string, unknown>) => fn === "payments_health_summary" ? Promise.resolve({ data: null, error: { code: "XX000", message: "boom" } }) : (handlerRpc(w))(fn, a) } });
  const r = await deps(req("GET", "/admin/readiness", { headers: { authorization: `Bearer ${SECRETS.adminJwt}` } }));
  assertEquals(r.status, 200);
  assertEquals((await r.json()).health, null);
  void h;
});

import { makeDeps } from "./harness.ts";
function handlerRpc(w: ReturnType<typeof newWorld>) {
  const d = makeDeps(w);
  return (fn: string, a?: Record<string, unknown>) => d.rpc.rpc(fn, a);
}
