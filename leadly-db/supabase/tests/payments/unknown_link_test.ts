// Camino "evento de un link que no esta en payments.payment_links" tras el retiro de la rama
// legacy: pasa directo a unknown_link con la misma firma y respuesta uniforme que antes, sin
// consultar ni escribir nada de public (sin oraculo de existencia). Arnes: RPC falso.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { addClient, createOwnLink, handler, newWorld, req, wompiEvent } from "./harness.ts";

const post = (h: (r: Request) => Promise<Response>, payload: unknown) => h(req("POST", "/v1/events/wompi", { body: payload }));
const SRC = (f: string) => new URL(`../../functions/_shared/payments-service/${f}`, import.meta.url);

Deno.test("checksum mal formado: 401 sin consultas, sin Vault, sin Wompi; una sola escritura (payments_record_event) y fila minima", async () => {
  const w = newWorld();
  const h = handler(w);
  const ev = await wompiEvent({ linkId: "wl_cualquiera", txId: "tx-IF" });
  (ev.signature as Record<string, unknown>).checksum = "no-es-hex";
  ev.data.transaction.customer_email = "x".repeat(200_000);
  const r = await post(h, ev);
  assertEquals(r.status, 401);
  assertEquals(w.rpcCalls.map((c) => c.fn), ["payments_record_event"]);
  assertEquals(w.rpcCalls[0].args.p_signature_valid, false);
  assertEquals(w.fetchCalls.length, 0);
  assert(JSON.stringify(w.events[0].raw).length < 1500, "fila minima");
  assertEquals(w.events[0].classification, "invalid_signature");
});

Deno.test("firma invalida de un link propio guarda solo el resumen minimo (sin PII ni payload de 200 KB)", async () => {
  const w = newWorld();
  const c = await addClient(w, { callback: null });
  const h = handler(w);
  const own = await createOwnLink(w, h, c.apiKey);
  const ev = await wompiEvent({ linkId: own.wompiLinkId!, txId: "tx-BIG", eventsKey: "mala" });
  ev.data.transaction.customer_email = "victima@example.com";
  (ev.data.transaction as Record<string, unknown>).blob = "y".repeat(200_000);
  const r = await post(h, ev);
  assertEquals(r.status, 401);
  const stored = JSON.stringify(w.events.at(-1)!.raw);
  assert(stored.length < 1500, `fila de ${stored.length} bytes`);
  assert(!stored.includes("victima@example.com"));
});

Deno.test("unknown_link: sin firma valida 401; con firma de plataforma valida 200 unknown_link; solo se usan las RPC del servicio", async () => {
  const w = newWorld();
  const h = handler(w);
  let r = await post(h, await wompiEvent({ linkId: "nadie", txId: "tx-U1" }));
  assertEquals(r.status, 200);
  assertEquals((await r.json()).classification, "unknown_link");
  assertEquals(w.events.at(-1)!.classification, "unknown_link");
  assertEquals(w.verify.calls.length, 0, "un evento desconocido nunca se confirma contra Wompi");
  r = await post(h, await wompiEvent({ linkId: "nadie", txId: "tx-U2", eventsKey: "mala" }));
  assertEquals(r.status, 401);
  assertEquals(w.events.at(-1)!.classification, "invalid_signature");
  const fns = new Set(w.rpcCalls.map((c) => c.fn));
  assertEquals([...fns].sort(), ["payments_find_link_by_wompi_id", "payments_record_event"]);
});

Deno.test("sin oraculo: el id de un cobro ex-legacy (factura / link de pedido que ya no se resuelve) responde IGUAL que uno que nunca existio", async () => {
  const w = newWorld();
  const h = handler(w);
  // mismas respuestas con firma invalida ...
  const exLegacyBad = await post(h, await wompiEvent({ linkId: "wl_factura_vieja_123", txId: "tx-A", eventsKey: "mala" }));
  const neverBad = await post(h, await wompiEvent({ linkId: "wl_nunca_existio_999", txId: "tx-B", eventsKey: "mala" }));
  assertEquals(exLegacyBad.status, 401);
  assertEquals(neverBad.status, 401);
  const a = (await exLegacyBad.json()).error;
  const b = (await neverBad.json()).error;
  assertEquals([a.code, a.message], [b.code, b.message]);
  // ... y con firma valida (unknown_link, 200): misma forma
  const exLegacyOk = await post(h, await wompiEvent({ linkId: "wl_factura_vieja_123", txId: "tx-C" }));
  const neverOk = await post(h, await wompiEvent({ linkId: "wl_nunca_existio_999", txId: "tx-D" }));
  assertEquals(exLegacyOk.status, 200);
  assertEquals(neverOk.status, 200);
  const x = await exLegacyOk.json();
  const y = await neverOk.json();
  assertEquals([x.ok, x.classification], [y.ok, y.classification]);
  assertEquals(Object.keys(x).sort(), Object.keys(y).sort());
  // nada se pago ni se entrego, sin llamadas a Wompi
  assertEquals(w.deliveries.length, 0);
  assertEquals(w.fetchCalls.length, 0);
});

Deno.test("sin credencial de plataforma: un evento desconocido recibe 503 (falla de configuracion propia), no un unknown_link", async () => {
  const w = newWorld();
  w.credential = null;
  const h = handler(w);
  const r = await post(h, await wompiEvent({ linkId: "nadie", txId: "tx-NC" }));
  assertEquals(r.status, 503);
  assertEquals(w.events.length, 0);
});

Deno.test("el receptor no conserva ninguna dependencia de la rama legacy ni de payment-webhook-wompi", async () => {
  for (const f of ["legacyOrigins.ts", "legacyStore.ts"]) {
    let exists = true;
    try { await Deno.stat(SRC(f)); } catch { exists = false; }
    assertEquals(exists, false, `${f} debe haberse eliminado`);
  }
  for (const f of ["eventsReceiver.ts", "eventSupport.ts", "unknownEvents.ts", "publicStatus.ts", "buildPaymentsDeps.ts", "types.ts"]) {
    const src = await Deno.readTextFile(SRC(f));
    const code = src.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/**")).join("\n");
    for (const banned of ["payment-webhook-wompi", "forwardForeign", "legacy", "Legacy", "sales_order_payment_links", "payment_invoices"]) {
      assert(!code.includes(banned), `${f} referencia ${banned} en codigo`);
    }
  }
});
