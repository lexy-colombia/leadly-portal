// Fusion de payment-webhook-wompi en payments-api: origenes (2) factura de
// plataforma y (3) link de pedido de un tenant, con el endurecimiento a-e.
// Arnes: RPC falso + LegacyStore falso (la version con SQL y supabase-js reales
// vive en integration_real.ts).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { addClient, addLegacyTarget, createOwnLink, handler, knownTransactions, newWorld, req, SECRETS, TENANT_KEYS, wompiEvent } from "./harness.ts";
import type { World } from "./harness.ts";

const post = (h: (r: Request) => Promise<Response>, payload: unknown) => h(req("POST", "/v1/events/wompi", { body: payload }));

type Origin = "invoice" | "order_link";
const keysFor = (o: Origin) => (o === "invoice" ? { eventsKey: SECRETS.eventsKey } : { eventsKey: TENANT_KEYS.eventsKey });
const classes = (w: World) => w.events.map((e) => e.classification);

function setup(origin: Origin, opts: { expectedCents?: number | null; linkId?: string } = {}) {
  const w = newWorld();
  const h = handler(w);
  const linkId = opts.linkId ?? `wl_${origin}_1`;
  const t = addLegacyTarget(w, { origin, wompiLinkId: linkId, expectedCents: opts.expectedCents });
  return { w, h, t, linkId };
}

for (const origin of ["invoice", "order_link"] as const) {
  const label = origin === "invoice" ? "(2) factura de plataforma" : "(3) link de pedido de un tenant";
  const paidClass = origin === "invoice" ? "legacy_invoice" : "legacy_order_payment";
  const paidState = origin === "invoice" ? "PAID" : "paid";
  const openState = origin === "invoice" ? "PENDING" : "pending";

  Deno.test(`${label}: evento válido APPROVED -> confirmado con Wompi, aplicado y guardado en la bandeja única`, async () => {
    const { w, h, t, linkId } = setup(origin);
    const r = await post(h, await wompiEvent({ linkId, txId: "tx-L1", ...keysFor(origin) }));
    assertEquals(r.status, 200);
    assertEquals((await r.json()).classification, paidClass);
    assertEquals(w.legacy.targets.get(linkId)!.status, paidState);
    assertEquals(w.legacy.applied.length, 1);
    assertEquals(w.verify.calls, ["tx-L1"]);
    assertEquals(w.events[0].classification, paidClass);
    assertEquals(w.events[0].origin, origin === "invoice" ? "legacy_invoice" : "legacy_order");
    assertEquals(w.events[0].origin_ref, t.id);
    assertEquals(w.events[0].signature_valid, true);
  });

  Deno.test(`${label}: monto distinto -> NO se paga, se guarda amount_mismatch`, async () => {
    const { w, h, linkId } = setup(origin);
    const r = await post(h, await wompiEvent({ linkId, txId: "tx-L2", amount: 100, ...keysFor(origin) }));
    assertEquals(r.status, 200);
    assertEquals((await r.json()).classification, "amount_mismatch");
    assertEquals(w.legacy.targets.get(linkId)!.status, openState);
    assertEquals(w.legacy.applied.length, 0);
  });

  Deno.test(`${label}: moneda distinta -> NO se paga`, async () => {
    const { w, h, linkId } = setup(origin);
    const r = await post(h, await wompiEvent({ linkId, txId: "tx-L3", currency: "USD", ...keysFor(origin) }));
    assertEquals((await r.json()).classification, "amount_mismatch");
    assertEquals(w.legacy.applied.length, 0);
  });

  Deno.test(`${label}: sin monto esperado almacenado -> falla cerrada (no se paga)`, async () => {
    const { w, h, linkId } = setup(origin, { expectedCents: null });
    const r = await post(h, await wompiEvent({ linkId, txId: "tx-L4", ...keysFor(origin) }));
    assertEquals((await r.json()).classification, "amount_mismatch");
    assertEquals(w.legacy.applied.length, 0);
  });

  Deno.test(`${label}: firma inválida (clave de otro merchant) -> 401, nada se paga, evento invalid_signature`, async () => {
    const { w, h, linkId } = setup(origin);
    const other = origin === "invoice" ? TENANT_KEYS.eventsKey : SECRETS.eventsKey; // la llave del merchant EQUIVOCADO
    const r = await post(h, await wompiEvent({ linkId, txId: "tx-L5", eventsKey: other }));
    assertEquals(r.status, 401);
    assertEquals(w.legacy.applied.length, 0);
    assertEquals(w.verify.calls.length, 0);
    assertEquals(classes(w), ["invalid_signature"]);
    assert(!JSON.stringify(w.events[0].raw).includes("persona@example.com"), "invalid_signature guarda solo el resumen mínimo");
  });

  Deno.test(`${label}: signature.properties incompleto (sin monto) -> 401 aunque el hash cuadre`, async () => {
    const { w, h, linkId } = setup(origin);
    const ev = await wompiEvent({ linkId, txId: "tx-L6", ...keysFor(origin) });
    ev.signature.properties = ["transaction.id", "transaction.status"];
    const { sha256Hex } = await import("../../functions/_shared/payments-service/hmac.ts");
    ev.signature.checksum = await sha256Hex(`tx-L6APPROVED${ev.timestamp}${keysFor(origin).eventsKey}`);
    const r = await post(h, ev);
    assertEquals(r.status, 401);
    assertEquals(w.legacy.applied.length, 0);
  });

  Deno.test(`${label}: Wompi caído en la confirmación -> 503, queda unverified; el reintento SÍ procesa`, async () => {
    const { w, h, linkId } = setup(origin);
    const ev = await wompiEvent({ linkId, txId: "tx-L7", ...keysFor(origin) });
    w.verify.mode = "network";
    const r1 = await post(h, ev);
    assertEquals(r1.status, 503);
    assertEquals(classes(w), ["unverified"]);
    assertEquals(w.legacy.applied.length, 0);
    assertEquals(w.legacy.targets.get(linkId)!.status, openState);
    w.verify.mode = "echo";
    const r2 = await post(h, ev);
    assertEquals(r2.status, 200);
    assertEquals((await r2.json()).classification, paidClass);
    assertEquals(w.legacy.targets.get(linkId)!.status, paidState);
  });

  Deno.test(`${label}: Wompi dice que la transacción es de OTRO link (replay con payment_link_id cambiado) -> verification_mismatch`, async () => {
    const { w, h, linkId } = setup(origin);
    // La transacción real pertenece a otro link; el atacante cambia el payment_link_id del cuerpo.
    const ev = await wompiEvent({ linkId, txId: "tx-L8", ...keysFor(origin) });
    knownTransactions.set("tx-L8", { ...knownTransactions.get("tx-L8")!, payment_link_id: "otro_link_real" });
    const r = await post(h, ev);
    assertEquals((await r.json()).classification, "verification_mismatch");
    assertEquals(w.legacy.applied.length, 0);
  });

  Deno.test(`${label}: Wompi responde 404 para la transacción -> verification_mismatch`, async () => {
    const { w, h, linkId } = setup(origin);
    w.verify.mode = "notfound";
    const r = await post(h, await wompiEvent({ linkId, txId: "tx-L9", ...keysFor(origin) }));
    assertEquals((await r.json()).classification, "verification_mismatch");
    assertEquals(w.legacy.applied.length, 0);
  });

  Deno.test(`${label}: evento duplicado -> duplicate, un solo pago`, async () => {
    const { w, h, linkId } = setup(origin);
    const ev = await wompiEvent({ linkId, txId: "tx-L10", ...keysFor(origin) });
    await post(h, ev);
    const r = await post(h, ev);
    assertEquals(r.status, 200);
    assertEquals((await r.json()).classification, "duplicate");
    assertEquals(w.legacy.applied.length, 1);
  });

  Deno.test(`${label}: orden de eventos -> DECLINED posterior al APPROVED no regresa el pago`, async () => {
    const { w, h, linkId } = setup(origin);
    await post(h, await wompiEvent({ linkId, txId: "tx-L11", ...keysFor(origin) }));
    const r = await post(h, await wompiEvent({ linkId, txId: "tx-L11b", status: "DECLINED", ...keysFor(origin) }));
    assertEquals(r.status, 200);
    assertEquals(w.legacy.targets.get(linkId)!.status, paidState);
    assertEquals(w.legacy.applied.filter((a) => a.status === "DECLINED").length, 0);
  });

  Deno.test(`${label}: DECLINED y luego APPROVED -> termina pagado`, async () => {
    const { w, h, linkId } = setup(origin);
    await post(h, await wompiEvent({ linkId, txId: "tx-L12a", status: "DECLINED", ...keysFor(origin) }));
    assertEquals(w.legacy.targets.get(linkId)!.status, openState);
    assertEquals(w.verify.calls.length, 0); // solo APPROVED se confirma
    await post(h, await wompiEvent({ linkId, txId: "tx-L12b", ...keysFor(origin) }));
    assertEquals(w.legacy.targets.get(linkId)!.status, paidState);
  });

  Deno.test(`${label}: segunda transacción aprobada sobre un destino ya pagado -> duplicate_payment, no acredita`, async () => {
    const { w, h, linkId } = setup(origin);
    await post(h, await wompiEvent({ linkId, txId: "tx-L13a", ...keysFor(origin) }));
    const r = await post(h, await wompiEvent({ linkId, txId: "tx-L13b", ...keysFor(origin) }));
    assertEquals((await r.json()).classification, "duplicate_payment");
    assertEquals(w.legacy.applied.filter((a) => a.status === "APPROVED").length, 1);
  });

  Deno.test(`${label}: destino ya no pendiente (anulado/vencido) + APPROVED -> legacy_not_applied con alerta crítica`, async () => {
    const w = newWorld();
    const h = handler(w);
    addLegacyTarget(w, { origin, wompiLinkId: "wl_closed", status: origin === "invoice" ? "CANCELLED" : "cancelled" });
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => logs.push(a.join(" "));
    let r: Response;
    try {
      r = await post(h, await wompiEvent({ linkId: "wl_closed", txId: "tx-L14", ...keysFor(origin) }));
    } finally {
      console.log = orig;
    }
    assertEquals((await r.json()).classification, "legacy_not_applied");
    assertEquals(w.legacy.applied.length, 0);
    assert(logs.some((l) => l.includes("legacy_approved_on_closed_target") && l.includes('"critical"')));
  });
}

Deno.test("replay cruzado entre orígenes: una transacción aplicada a la factura (2) no acredita el link de pedido (3) ni un link del servicio nuevo (1)", async () => {
  const w = newWorld();
  const h = handler(w);
  addLegacyTarget(w, { origin: "invoice", wompiLinkId: "wl_inv" });
  addLegacyTarget(w, { origin: "order_link", wompiLinkId: "wl_ord" });
  const c = await addClient(w, { callback: null });
  const own = await createOwnLink(w, h, c.apiKey);

  // Pago legítimo de la factura.
  let r = await post(h, await wompiEvent({ linkId: "wl_inv", txId: "tx-X", ...keysFor("invoice") }));
  assertEquals((await r.json()).classification, "legacy_invoice");

  // Mismo cuerpo reenviado con el payment_link_id del link de pedido (firma del tenant recalculada: la ve valida)
  const toOrder = await wompiEvent({ linkId: "wl_ord", txId: "tx-X", ...keysFor("order_link") });
  r = await post(h, toOrder);
  assertEquals((await r.json()).classification, "transaction_conflict");
  assertEquals(w.legacy.targets.get("wl_ord")!.status, "pending");

  // ...y con el id del link del servicio nuevo (misma clave de plataforma).
  const toOwn = await wompiEvent({ linkId: own.wompiLinkId!, txId: "tx-X" });
  r = await post(h, toOwn);
  assertEquals((await r.json()).classification, "transaction_conflict");
  assertEquals(w.links[0].status, "pending");
});

Deno.test("replay: transacción registrada en las tablas legacy (usedTx) bajo otro destino -> transaction_conflict aunque payments.events no la conozca", async () => {
  const { w, h, linkId } = setup("order_link");
  w.legacy.usedTx.set("tx-OLD", "otro-destino-id");
  const r = await post(h, await wompiEvent({ linkId, txId: "tx-OLD", ...keysFor("order_link") }));
  assertEquals((await r.json()).classification, "transaction_conflict");
  assertEquals(w.legacy.applied.length, 0);
});

Deno.test("(3) el evento de un tenant se verifica con la llave PRIVADA de ese tenant, no con la de plataforma", async () => {
  const { w, h, linkId } = setup("order_link");
  w.legacy.credentials.set(w.legacy.targets.get(linkId)!.merchantTenantId!, { mode: "sandbox", privateKey: null, eventsKey: TENANT_KEYS.eventsKey });
  const r = await post(h, await wompiEvent({ linkId, txId: "tx-K", ...keysFor("order_link") }));
  assertEquals(r.status, 503); // sin llave privada: no se confirma, no se paga
  assertEquals(w.legacy.applied.length, 0);
});

Deno.test("(3) sin credencial del TENANT -> 401 con el MISMO cuerpo que una firma inválida (sin oráculo), motivo real solo en log; nada se aplica", async () => {
  const { w, h, linkId } = setup("order_link");
  w.legacy.credentials.set(w.legacy.targets.get(linkId)!.merchantTenantId!, null);
  const noCred = await post(h, await wompiEvent({ linkId, txId: "tx-M", ...keysFor("order_link") }));
  const badSig = await post(h, await wompiEvent({ linkId: "no-existe", txId: "tx-M2", eventsKey: "mala" }));
  assertEquals(noCred.status, 401);
  assertEquals(badSig.status, 401);
  assertEquals((await noCred.json()).error.code, (await badSig.json()).error.code);
  assertEquals(w.legacy.applied.length, 0);
  assertEquals(classes(w).at(0), "invalid_signature");
});

Deno.test("(2) sin credencial de PLATAFORMA -> 503 (falla de configuración propia)", async () => {
  const { w, h, linkId } = setup("invoice");
  w.credential = null;
  const r = await post(h, await wompiEvent({ linkId, txId: "tx-M3", ...keysFor("invoice") }));
  assertEquals(r.status, 503);
  assertEquals(w.legacy.applied.length, 0);
});

Deno.test("(2) factura soft-deleted + APPROVED -> legacy_not_applied con alerta, no se paga", async () => {
  const w = newWorld();
  const h = handler(w);
  addLegacyTarget(w, { origin: "invoice", wompiLinkId: "wl_del", deleted: true });
  const r = await post(h, await wompiEvent({ linkId: "wl_del", txId: "tx-DEL", ...keysFor("invoice") }));
  assertEquals((await r.json()).classification, "legacy_not_applied");
  assertEquals(w.legacy.applied.length, 0);
});

Deno.test("checksum mal formado / sin signature: 401 sin consultas, sin Vault, sin Wompi; fila mínima", async () => {
  const { w, h, linkId } = setup("order_link");
  const ev = await wompiEvent({ linkId, txId: "tx-IF", ...keysFor("order_link") });
  (ev.signature as Record<string, unknown>).checksum = "no-es-hex";
  ev.data.transaction.customer_email = "x".repeat(200_000);
  const r = await post(h, ev);
  assertEquals(r.status, 401);
  assertEquals(w.rpcCalls.map((c) => c.fn), ["payments_record_legacy_event"]);
  assertEquals(w.fetchCalls.length, 0);
  assert(JSON.stringify(w.events[0].raw).length < 1500, "fila mínima");
  assertEquals(w.events[0].classification, "invalid_signature");
});

Deno.test("firma inválida de un link propio guarda solo el resumen mínimo (sin PII ni payload de 200 KB)", async () => {
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

Deno.test("(2)/(3) mismo wompi_link_id en más de una fila legacy (ambiguo) -> no se paga nada, legacy_not_applied con alerta", async () => {
  const { w, h, linkId } = setup("invoice");
  w.legacy.ambiguous.add(linkId);
  const r = await post(h, await wompiEvent({ linkId, txId: "tx-N", ...keysFor("invoice") }));
  assertEquals(r.status, 200);
  assertEquals(w.legacy.applied.length, 0);
  assertEquals(classes(w), ["legacy_not_applied"]);
  assertEquals(w.events[0].origin_ref, `ambiguous:${linkId}`);
});

Deno.test("orden de resolución: un link del servicio nuevo gana sobre un destino legacy con el mismo id", async () => {
  const w = newWorld();
  const h = handler(w);
  const c = await addClient(w, { callback: null });
  const own = await createOwnLink(w, h, c.apiKey);
  addLegacyTarget(w, { origin: "invoice", wompiLinkId: own.wompiLinkId! });
  const r = await post(h, await wompiEvent({ linkId: own.wompiLinkId!, txId: "tx-O" }));
  assertEquals((await r.json()).classification, "processed");
  assertEquals(w.legacy.applied.length, 0);
  assertEquals(w.links[0].status, "paid");
});

Deno.test("evento desconocido: sin firma válida 401, con firma de plataforma válida unknown_link 200", async () => {
  const w = newWorld();
  const h = handler(w);
  let r = await post(h, await wompiEvent({ linkId: "nadie", txId: "tx-U1" }));
  assertEquals(r.status, 200);
  assertEquals(w.events.at(-1)!.classification, "unknown_link");
  r = await post(h, await wompiEvent({ linkId: "nadie", txId: "tx-U2", eventsKey: "mala" }));
  assertEquals(r.status, 401);
  assertEquals(w.events.at(-1)!.classification, "invalid_signature");
});

Deno.test("la fusión no deja ninguna dependencia de payment-webhook-wompi en el receptor", async () => {
  for (const f of ["eventsReceiver.ts", "legacyOrigins.ts", "legacyStore.ts", "eventSupport.ts"]) {
    const src = await Deno.readTextFile(new URL(`../../functions/_shared/payments-service/${f}`, import.meta.url));
    const code = src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    assert(!code.includes("payment-webhook-wompi"), `${f} referencia payment-webhook-wompi en código`);
    assert(!code.includes("forwardForeign"), `${f} conserva forwardForeign`);
  }
});
