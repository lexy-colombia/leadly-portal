// ST4: creadores internos de Leadly por el servicio (in-process): pedido
// (createSalesOrderPaymentLink), factura de plataforma (ensureInvoiceCheckout),
// reconciliacion (syncInvoiceFromService) y el script de arranque del cliente interno.
// Fakes del arnes: sin red ni base de datos.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { createSalesOrderPaymentLink } from "../../functions/_shared/payments/salesOrderPayments.ts";
import { ensureInvoiceCheckout } from "../../functions/_shared/payments/invoiceCheckout.ts";
import type { InvoiceForCheckout } from "../../functions/_shared/payments/invoiceCheckout.ts";
import { syncInvoiceFromService } from "../../functions/_shared/payments/syncInvoice.ts";
import { GENERIC_MESSAGE } from "../../functions/_shared/payments-service/internalLinks.ts";
import { bootstrapInternalClient, renderOutcome } from "../../../scripts/create_internal_payments_client.ts";
import { addClient, MERCHANT_KEYS, makeDeps, newWorld, SECRETS } from "./harness.ts";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ORDER = "33333333-3333-4333-8333-333333333333";
const INVOICE = "44444444-4444-4444-8444-444444444444";
type W = ReturnType<typeof newWorld>;
type Row = Record<string, any>;

/** supabase-js falso, lo justo para las consultas de los creadores. */
function fakeAdmin(tables: Record<string, Row[]>, rpc?: (fn: string, args: Row) => { data: unknown; error: unknown }) {
  const calls: Array<{ table: string; op: string; patch?: Row }> = [];
  const from = (table: string) => {
    let op = "select";
    let patch: Row | undefined;
    const filters: Array<(r: Row) => boolean> = [];
    const run = () => {
      const rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      if (op === "update") {
        for (const r of rows) Object.assign(r, patch);
        calls.push({ table, op, patch });
      }
      return rows;
    };
    const b: any = {
      select: () => b,
      update: (p: Row) => { op = "update"; patch = p; return b; },
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return b; },
      is: (c: string, v: unknown) => { filters.push((r) => (r[c] ?? null) === v); return b; },
      maybeSingle: () => Promise.resolve({ data: run()[0] ?? null, error: null }),
      then: (res: any, rej: any) => Promise.resolve({ data: run(), error: null }).then(res, rej),
    };
    return b;
  };
  return { from, rpc: (fn: string, args: Row) => Promise.resolve(rpc ? rpc(fn, args) : { data: null, error: null }), calls } as any;
}

const orderRow = (over: Row = {}): Row => ({ id: ORDER, tenant_id: TENANT, number: 7, status: "confirmada", total: 12000, currency: "COP", deleted_at: null, ...over });
const merchantCred = { mode: "sandbox" as const, privateKey: MERCHANT_KEYS.privateKey, eventsKey: MERCHANT_KEYS.eventsKey };

async function setup(o: { merchant?: boolean } = {}) {
  const w = newWorld();
  if (o.merchant !== false) w.merchants.set(TENANT, merchantCred);
  const { client } = await addClient(w, { kind: "internal" });
  const opts = { deps: makeDeps(w), clientId: String(client.id) };
  return { w, opts, client };
}
const wompiPosts = (w: W) => w.fetchCalls.filter((c) => c.url.endsWith("/payment_links"));
const wompiBody = (w: W, i = 0) => JSON.parse(String(wompiPosts(w)[i].init.body));
const orders = (rows: Row[] = [orderRow()], payments: Row[] = []) => fakeAdmin({ sales_orders: rows, sales_order_payments: payments });

Deno.test("pedido: link por el servicio, comercio y metadata desde la FILA del pedido, sin taxes, redirect por defecto del servicio", async () => {
  const { w, opts } = await setup();
  const r = await createSalesOrderPaymentLink(orders([orderRow()], [{ order_id: ORDER, amount: 2000, deleted_at: null }]), TENANT, ORDER, null, undefined, opts);
  assertEquals(r.amount, 10000);
  assertEquals(r.orderCode, "007");
  assertEquals(w.links.length, 1);
  const l = w.links[0];
  assertEquals(l.merchant_tenant_id, TENANT);
  assertEquals(l.external_reference, `order:${ORDER}`);
  assertEquals(l.metadata, { kind: "order", tenant_id: TENANT, order_id: ORDER });
  assertEquals(l.amount_in_cents, 1_000_000);
  assertEquals(l.environment, "sandbox");
  assert(/^order:[0-9a-f-]{36}:[0-9a-f-]{36}$/.test(l.idempotency_key));
  assertEquals(r.checkoutUrl, l.checkout_url);
  const body = wompiBody(w);
  assertEquals("taxes" in body, false, "D7: sin taxes en pedidos");
  assertEquals(body.redirect_url, `https://leadly.lexycolombia.com/pago/resultado?link=${l.id}`);
  assertEquals(w.rpcCalls.filter((c) => c.fn === "payments_begin_link")[0].args.p_merchant_tenant_id, TENANT);
  assertEquals(wompiPosts(w)[0].init.headers && (wompiPosts(w)[0].init.headers as Record<string, string>).Authorization, `Bearer ${MERCHANT_KEYS.privateKey}`);
});

Deno.test("pedido: un redirectUrl explicito gana", async () => {
  const { w, opts } = await setup();
  await createSalesOrderPaymentLink(orders(), TENANT, ORDER, "99999999-9999-4999-8999-999999999999", "https://tienda.example.com/tienda/x/carrito?payment=return", opts);
  assertEquals(wompiBody(w).redirect_url, "https://tienda.example.com/tienda/x/carrito?payment=return");
  assertEquals(w.links[0].created_by, "99999999-9999-4999-8999-999999999999");
});

Deno.test("pedido: el tenant del parametro NO manda: otro tenant no encuentra el pedido y no se crea nada", async () => {
  const { w, opts } = await setup();
  await assertRejects(() => createSalesOrderPaymentLink(orders(), OTHER, ORDER, null, undefined, opts), Error, "No se encontró el pedido");
  assertEquals(w.links.length, 0);
  assertEquals(wompiPosts(w).length, 0);
});

Deno.test("pedido: cada intento usa una Idempotency-Key distinta (dos links)", async () => {
  const { w, opts } = await setup();
  await createSalesOrderPaymentLink(orders(), TENANT, ORDER, null, undefined, opts);
  await createSalesOrderPaymentLink(orders(), TENANT, ORDER, null, undefined, opts);
  assertEquals(w.links.length, 2);
  assert(w.links[0].idempotency_key !== w.links[1].idempotency_key);
});

Deno.test("pedido: falla CERRADA sin PAYMENTS_INTERNAL_CLIENT_ID (ausente o no uuid): ni RPC ni Wompi", async () => {
  const w = newWorld();
  w.merchants.set(TENANT, merchantCred);
  const deps = makeDeps(w);
  const prev = Deno.env.get("PAYMENTS_INTERNAL_CLIENT_ID");
  Deno.env.delete("PAYMENTS_INTERNAL_CLIENT_ID");
  try {
    for (const clientId of [undefined, "no-es-uuid"]) {
      const e = await assertRejects(() => createSalesOrderPaymentLink(orders(), TENANT, ORDER, null, undefined, { deps, clientId }), Error);
      assertEquals(e.message, GENERIC_MESSAGE);
      assert(!/PAYMENTS_|CLIENT_ID/.test(e.message), "el mensaje al usuario no nombra variables");
    }
  } finally {
    if (prev !== undefined) Deno.env.set("PAYMENTS_INTERNAL_CLIENT_ID", prev);
  }
  assertEquals(w.rpcCalls.length, 0);
  assertEquals(w.fetchCalls.length, 0);
  assertEquals(w.links.length, 0);
});

Deno.test("pedido: un cliente externo (id mal configurado) no puede cobrar a nombre de un comercio", async () => {
  const w = newWorld();
  w.merchants.set(TENANT, merchantCred);
  const { client } = await addClient(w, { kind: "external" });
  const e = await assertRejects(() => createSalesOrderPaymentLink(orders(), TENANT, ORDER, null, undefined, { deps: makeDeps(w), clientId: String(client.id) }), Error);
  assertEquals(e.message, GENERIC_MESSAGE);
  assertEquals(wompiPosts(w).length, 0);
});

Deno.test("pedido: comercio sin credencial -> error claro, sin llamar a Wompi ni caer a la plataforma", async () => {
  const { w, opts } = await setup({ merchant: false });
  const e = await assertRejects(() => createSalesOrderPaymentLink(orders(), TENANT, ORDER, null, undefined, opts), Error);
  assert(/comercio no tiene Wompi configurado/.test(e.message) && !/credencial|llave|prv_|events/i.test(e.message));
  assertEquals(wompiPosts(w).length, 0);
});

Deno.test("pedido: Wompi rechaza -> error del cobro (no devuelve URL)", async () => {
  const { w, opts } = await setup();
  w.wompi.status = 422;
  w.wompi.body = { error: { messages: { name: ["malo"] } } };
  await assertRejects(() => createSalesOrderPaymentLink(orders(), TENANT, ORDER, null, undefined, opts), Error, GENERIC_MESSAGE);
  assertEquals(w.links[0].status, "error");
});

Deno.test("pedido: un replay que devuelve el link en 'error' o sin URL se trata como fallo (I6)", async () => {
  for (const [status, url] of [["error", "https://checkout.wompi.co/l/x"], ["pending", null]] as const) {
    const { w, opts } = await setup();
    const base = makeDeps(w);
    const deps = {
      ...base,
      rpc: {
        rpc: (fn: string, args: Record<string, unknown> = {}) => {
          if (fn === "payments_begin_link") {
            return Promise.resolve({ data: { link: { id: crypto.randomUUID(), status, checkout_url: url }, replayed: true }, error: null });
          }
          return base.rpc.rpc(fn, args);
        },
      },
    };
    await assertRejects(() => createSalesOrderPaymentLink(orders(), TENANT, ORDER, null, undefined, { deps, clientId: opts.clientId }), Error, GENERIC_MESSAGE);
    assertEquals(wompiPosts(w).length, 0);
  }
});

Deno.test("pedido: no confirmado / ya pagado / no COP siguen siendo errores del cobro, sin tocar el servicio", async () => {
  const { w, opts } = await setup();
  await assertRejects(() => createSalesOrderPaymentLink(orders([orderRow({ status: "cotizacion" })]), TENANT, ORDER, null, undefined, opts), Error, "ya confirmado");
  await assertRejects(() => createSalesOrderPaymentLink(orders([orderRow()], [{ order_id: ORDER, amount: 12000, deleted_at: null }]), TENANT, ORDER, null, undefined, opts), Error, "ya está pagado");
  await assertRejects(() => createSalesOrderPaymentLink(orders([orderRow({ currency: "USD" })]), TENANT, ORDER, null, undefined, opts), Error, "COP");
  assertEquals(w.rpcCalls.length, 0);
});

// ------------------------------------------------------------------ facturas
const invoice = (over: Partial<InvoiceForCheckout> = {}): InvoiceForCheckout => ({
  id: INVOICE, merchant_tenant_id: null, payer_tenant_id: TENANT, provider_key: "wompi", amount_cents: 11_900_000, currency: "COP",
  description: "Plan Pro octubre", invoice_number: "INV-1", payments_link_id: null,
  tax_rate: 19, tax_cents: 1_900_000, period_start: null, period_end: null, ...over,
});
const invRows = (over: Partial<InvoiceForCheckout> = {}) => [{ ...invoice(over) } as Row];

Deno.test("factura: comercio plataforma, metadata con el pagador de la FILA, IVA 19% explicito, guarda payments_link_id", async () => {
  const { w, opts } = await setup();
  const rows = invRows();
  const admin = fakeAdmin({ payment_invoices: rows });
  const r = await ensureInvoiceCheckout(admin, invoice(), "99999999-9999-4999-8999-999999999999", undefined, opts);
  assert(r.ok);
  const l = w.links[0];
  assertEquals(l.merchant_tenant_id, null);
  assertEquals(l.external_reference, `invoice:${INVOICE}`);
  assertEquals(l.metadata, { kind: "invoice", tenant_id: TENANT, invoice_id: INVOICE });
  assertEquals(l.environment, "sandbox");
  assertEquals(wompiBody(w).taxes, [{ type: "VAT", amount_in_cents: Math.round((11_900_000 * 19) / 119) }]);
  assertEquals(wompiBody(w).taxes[0].amount_in_cents, 1_900_000);
  assertEquals(rows[0].payments_link_id, l.id);
  assertEquals(wompiBody(w).redirect_url, `https://leadly.lexycolombia.com/pago/resultado?link=${l.id}`);
  assertEquals(wompiPosts(w)[0].init.headers && (wompiPosts(w)[0].init.headers as Record<string, string>).Authorization, `Bearer ${SECRETS.privateKey}`);
});

Deno.test("factura: name/description de Wompi = Comprobante de cobro + plan + periodo (sin periodo, sin parentesis)", async () => {
  const { w, opts } = await setup();
  const a = await ensureInvoiceCheckout(fakeAdmin({ payment_invoices: invRows() }), invoice({ period_start: "2026-10-10", period_end: "2026-11-10" }), null, undefined, opts);
  assert(a.ok);
  assertEquals(wompiBody(w, 0).name, "Comprobante de cobro INV-1 · Plan Pro octubre (10 oct 2026 – 10 nov 2026)");
  assertEquals(wompiBody(w, 0).description, wompiBody(w, 0).name);
  const b = await ensureInvoiceCheckout(fakeAdmin({ payment_invoices: invRows() }), invoice(), null, undefined, opts);
  assert(b.ok);
  assertEquals(wompiBody(w, 1).name, "Comprobante de cobro INV-1 · Plan Pro octubre");
  // solo un extremo del periodo o fecha invalida: tampoco parentesis
  await ensureInvoiceCheckout(fakeAdmin({ payment_invoices: invRows() }), invoice({ period_start: "2026-10-10", period_end: null }), null, undefined, opts);
  assertEquals(wompiBody(w, 2).name, "Comprobante de cobro INV-1 · Plan Pro octubre");
  // sin plan ni numero: cae al id
  await ensureInvoiceCheckout(fakeAdmin({ payment_invoices: invRows() }), invoice({ description: null, invoice_number: null }), null, undefined, opts);
  assertEquals(wompiBody(w, 3).name, `Comprobante de cobro ${INVOICE}`);
  assert(!/factura/i.test(String(wompiBody(w, 0).name)));
});

Deno.test("factura: name > 150 recorta el PLAN y conserva numero y periodo; description lleva el texto completo", async () => {
  const { w, opts } = await setup();
  const plan = "Plan Enterprise a la medida con modulos " + "x".repeat(200);
  await ensureInvoiceCheckout(fakeAdmin({ payment_invoices: invRows() }), invoice({ description: plan, period_start: "2026-10-10", period_end: "2026-11-10" }), null, undefined, opts);
  const name = String(wompiBody(w, 0).name);
  assert(name.length <= 150, String(name.length));
  assert(name.startsWith("Comprobante de cobro INV-1 · Plan Enterprise") && name.includes("…") && name.endsWith("(10 oct 2026 – 10 nov 2026)"), name);
  assert(String(wompiBody(w, 0).description).endsWith("(10 oct 2026 – 10 nov 2026)") && String(wompiBody(w, 0).description).includes("x".repeat(100)));
});

Deno.test("factura anulada (deleted_at): NO crea link, 409 'anulado', no llama al servicio; el sync tampoco la reconcilia", async () => {
  const { w, opts } = await setup();
  const r = await ensureInvoiceCheckout(fakeAdmin({ payment_invoices: invRows() }), invoice({ deleted_at: "2026-10-20T00:00:00Z" }), null, undefined, opts);
  assert(!r.ok && r.status === 409 && r.error === "Este comprobante fue anulado.");
  assertEquals(w.links.length, 0);
  assertEquals(wompiPosts(w).length, 0);
  assertEquals(w.rpcCalls.length, 0);
  const calls: string[] = [];
  const admin = fakeAdmin({}, (fn) => { calls.push(fn); return { data: { result: "applied" }, error: null }; });
  const out = await syncInvoiceFromService(admin, { id: INVOICE, payer_tenant_id: TENANT, payments_link_id: crypto.randomUUID(), deleted_at: "2026-10-20T00:00:00Z" }, opts);
  assertEquals(out, { synced: false, result: "invoice_deleted" });
  assertEquals(calls.length, 0);
});

Deno.test("factura: impuestos del link = los de la fila; tasa 0 o tax_cents 0/null -> sin `taxes`", async () => {
  const { w, opts } = await setup();
  // tasa 8 propia (no el 19 fijo)
  await ensureInvoiceCheckout(fakeAdmin({ payment_invoices: invRows() }), invoice({ amount_cents: 10_800_000, tax_rate: 8, tax_cents: 800_000 }), null, undefined, opts);
  assertEquals(wompiBody(w, 0).taxes, [{ type: "VAT", amount_in_cents: 800_000 }]);
  assertEquals(w.links[0].amount_in_cents, 10_800_000);
  const cases: Array<Partial<InvoiceForCheckout>> = [
    { tax_rate: 0, tax_cents: 0 }, { tax_rate: 0, tax_cents: 1_900_000 }, { tax_rate: 19, tax_cents: 0 },
    { tax_rate: 19, tax_cents: null }, { tax_rate: null, tax_cents: null }, { tax_rate: undefined, tax_cents: undefined },
  ];
  for (let i = 0; i < cases.length; i++) {
    const r = await ensureInvoiceCheckout(fakeAdmin({ payment_invoices: invRows() }), invoice(cases[i]), null, undefined, opts);
    assert(r.ok, `caso ${i}`);
    assert(!("taxes" in wompiBody(w, i + 1)), `caso ${i}: no debe mandar taxes`);
  }
});

Deno.test("factura: tax_cents mayor al monto (o no entero) -> no construye link, 409 y log critical", async () => {
  const { w, opts } = await setup();
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
  const outs = [];
  try {
    for (const tax_cents of [11_900_001, 1.5]) {
      outs.push(await ensureInvoiceCheckout(fakeAdmin({ payment_invoices: invRows() }), invoice({ tax_cents }), null, undefined, opts));
    }
    // igual al monto: el servicio lo admite (suma <= monto)
    outs.push(await ensureInvoiceCheckout(fakeAdmin({ payment_invoices: invRows() }), invoice({ tax_cents: 11_900_000 }), null, undefined, opts));
  } finally {
    console.log = orig;
  }
  assert(!outs[0].ok && outs[0].status === 409 && /comprobante/.test(outs[0].error));
  assert(!outs[1].ok && outs[1].status === 409);
  assert(outs[2].ok);
  assertEquals(wompiPosts(w).length, 1, "solo el valido llego a Wompi");
  assertEquals(w.links.length, 1);
  assertEquals(logs.filter((l) => l.includes("invoice_tax_invalid")).length, 2);
});

Deno.test("factura: mensajes al tenant dicen comprobante, no factura", async () => {
  const { opts } = await setup();
  const admin = fakeAdmin({ payment_invoices: invRows() });
  const msgs: string[] = [];
  for (const over of [{ provider_key: "manual" }, { payer_tenant_id: null }, { tax_cents: 99_999_999 }] as Array<Partial<InvoiceForCheckout>>) {
    const r = await ensureInvoiceCheckout(admin, invoice(over), null, undefined, opts);
    assert(!r.ok);
    msgs.push(r.error);
  }
  for (const m of msgs) assert(/comprobante/i.test(m) && !/factura/i.test(m), m);
});

Deno.test("factura: redirect https explicito gana; uno no-https se ignora (no rompe el cobro)", async () => {
  const { w, opts } = await setup();
  await ensureInvoiceCheckout(fakeAdmin({ payment_invoices: invRows() }), invoice(), null, "https://leadly.example.com/billing", opts);
  assertEquals(wompiBody(w, 0).redirect_url, "https://leadly.example.com/billing");
  const r = await ensureInvoiceCheckout(fakeAdmin({ payment_invoices: invRows() }), invoice(), null, "http://localhost:5173/billing", opts);
  assert(r.ok);
  assert(String(wompiBody(w, 1).redirect_url).includes("/pago/resultado?link="));
});

Deno.test("factura: reutiliza el link pendiente; uno vencido/en error se reemplaza; uno pagado -> 409", async () => {
  const { w, opts } = await setup();
  const rows = invRows();
  const admin = fakeAdmin({ payment_invoices: rows });
  const first = await ensureInvoiceCheckout(admin, invoice(), null, undefined, opts);
  assert(first.ok);
  const again = await ensureInvoiceCheckout(admin, invoice({ payments_link_id: rows[0].payments_link_id }), null, undefined, opts);
  assert(again.ok);
  assertEquals(again.checkoutUrl, first.checkoutUrl);
  assertEquals(wompiPosts(w).length, 1, "no crea otro link");

  w.links[0].status = "expired";
  const oldId = rows[0].payments_link_id;
  const renewed = await ensureInvoiceCheckout(admin, invoice({ payments_link_id: oldId }), null, undefined, opts);
  assert(renewed.ok);
  assert(renewed.checkoutUrl !== first.checkoutUrl);
  assert(rows[0].payments_link_id !== oldId, "payments_link_id apunta al nuevo");

  w.links[1].status = "paid";
  const paid = await ensureInvoiceCheckout(admin, invoice({ payments_link_id: rows[0].payments_link_id }), null, undefined, opts);
  assert(!paid.ok && paid.status === 409);
});

Deno.test("factura: carrera perdida (otro guardo payments_link_id antes) -> devuelve el link ganador", async () => {
  const { w, opts } = await setup();
  const rows = invRows();
  const admin = fakeAdmin({ payment_invoices: rows });
  const winner = await ensureInvoiceCheckout(admin, invoice(), null, undefined, opts);
  assert(winner.ok);
  // el llamador de esta peticion aun creia que no habia link (leyo antes de la carrera)
  const loser = await ensureInvoiceCheckout(admin, invoice({ payments_link_id: null }), null, undefined, opts);
  assert(loser.ok);
  assertEquals(loser.checkoutUrl, winner.checkoutUrl);
  assertEquals(w.links.length, 2);
  assertEquals(rows[0].payments_link_id, w.links[0].id);
});

Deno.test("factura: no-wompi y sin pagador -> 400; una fila con provider_checkout_id (columna retirada) ya no devuelve una URL legacy", async () => {
  const { w, opts } = await setup();
  const admin = fakeAdmin({ payment_invoices: invRows() });
  // sin payments_link_id se crea un link del servicio; ningun camino reconstruye una URL a partir de un id legacy
  const legacy = await ensureInvoiceCheckout(admin, { ...invoice(), provider_checkout_id: "legacy123" } as never, null, undefined, opts);
  assert(legacy.ok && legacy.checkoutUrl !== "https://checkout.wompi.co/l/legacy123");
  assertEquals(w.links.length, 1);
  const manual = await ensureInvoiceCheckout(admin, invoice({ provider_key: "manual" }), null, undefined, opts);
  assert(!manual.ok && manual.status === 400);
  const noPayer = await ensureInvoiceCheckout(admin, invoice({ payer_tenant_id: null }), null, undefined, opts);
  assert(!noPayer.ok && noPayer.status === 400);
  assertEquals(w.links.length, 1);
});

Deno.test("factura: falla cerrada sin PAYMENTS_INTERNAL_CLIENT_ID", async () => {
  const w = newWorld();
  const prev = Deno.env.get("PAYMENTS_INTERNAL_CLIENT_ID");
  Deno.env.delete("PAYMENTS_INTERNAL_CLIENT_ID");
  try {
    await assertRejects(() => ensureInvoiceCheckout(fakeAdmin({ payment_invoices: invRows() }), invoice(), null, undefined, { deps: makeDeps(w) }), Error, GENERIC_MESSAGE);
  } finally {
    if (prev !== undefined) Deno.env.set("PAYMENTS_INTERNAL_CLIENT_ID", prev);
  }
  assertEquals(w.fetchCalls.length, 0);
});

// ------------------------------------------------------------------ sync
Deno.test("sync: link 'paid' -> apply_wompi_invoice_payment con el tenant de la FILA; pendiente -> no aplica", async () => {
  const { w, opts } = await setup();
  const rows = invRows();
  await ensureInvoiceCheckout(fakeAdmin({ payment_invoices: rows }), invoice(), null, undefined, opts);
  const calls: Array<{ fn: string; args: Row }> = [];
  const admin = fakeAdmin({}, (fn, args) => { calls.push({ fn, args }); return { data: { result: "applied" }, error: null }; });
  const inv = { id: INVOICE, payer_tenant_id: TENANT, payments_link_id: String(rows[0].payments_link_id) };

  assertEquals(await syncInvoiceFromService(admin, inv, opts), { synced: false, result: "link_pending" });
  assertEquals(calls.length, 0);

  w.links[0].status = "paid";
  w.links[0].paid_transaction_id = "tx-9";
  const out = await syncInvoiceFromService(admin, inv, opts);
  assertEquals(out, { synced: true, result: "applied" });
  assertEquals(calls.length, 1);
  assertEquals(calls[0].fn, "apply_wompi_invoice_payment");
  assertEquals(calls[0].args.p_tenant_id, TENANT);
  assertEquals(calls[0].args.p_invoice_id, INVOICE);
  assertEquals(calls[0].args.p_transaction_id, "tx-9");
  assertEquals(calls[0].args.p_amount_cents, 11_900_000);
});

Deno.test("sync: 'duplicate' no cuenta como sincronizada; link inexistente no revienta", async () => {
  const { w, opts } = await setup();
  const rows = invRows();
  await ensureInvoiceCheckout(fakeAdmin({ payment_invoices: rows }), invoice(), null, undefined, opts);
  w.links[0].status = "paid";
  w.links[0].paid_transaction_id = "tx-9";
  const inv = { id: INVOICE, payer_tenant_id: TENANT, payments_link_id: String(rows[0].payments_link_id) };
  const dup = await syncInvoiceFromService(fakeAdmin({}, () => ({ data: { result: "duplicate" }, error: null })), inv, opts);
  assertEquals(dup, { synced: false, result: "duplicate" });
  const missing = await syncInvoiceFromService(fakeAdmin({}), { ...inv, payments_link_id: crypto.randomUUID() }, opts);
  assertEquals(missing, { synced: false, result: "link_not_found" });
});

// ------------------------------------------------------------------ script de arranque
Deno.test("script de arranque: crea el cliente interno una sola vez, sin exponer API key ni secreto", async () => {
  const w = newWorld();
  const rpc = makeDeps(w).rpc;
  const url = "https://abcdefghij.supabase.co";
  const r1 = await bootstrapInternalClient(rpc, url);
  assert(r1.created);
  assertEquals(w.clients.length, 1);
  const c = w.clients[0];
  assertEquals(c.kind, "internal");
  assertEquals(c.callback_url, `${url}/functions/v1/payments-internal`);
  assertEquals(c.id, r1.clientId);
  const secret = w.vault.get(String(c.signing_secret_name));
  assert(secret && secret.startsWith("lxy_whsec_"));
  const printed = JSON.stringify(r1);
  assert(!printed.includes(secret) && !printed.includes("lxy_pay_"), "no expone secreto ni API key");

  const r2 = await bootstrapInternalClient(rpc, url);
  assertEquals(r2.created, false);
  assertEquals(r2.clientId, r1.clientId);
  assertEquals(w.clients.length, 1, "re-ejecucion: no crea otro");
  assertEquals(w.vault.size, 1, "ni otro secreto");

  await assertRejects(() => bootstrapInternalClient(rpc, "http://localhost:54321"), Error, "SUPABASE_URL");
});

Deno.test("script de arranque: un cliente con ese nombre que NO es interno se reporta, no se pisa", async () => {
  const w = newWorld();
  await addClient(w, { name: "Leadly (interno)", kind: "external" });
  const r = await bootstrapInternalClient(makeDeps(w).rpc, "https://abcdefghij.supabase.co");
  assertEquals(r.created, false);
  assert(!r.created && r.note.includes("NO es el interno"));
  assertEquals(w.clients.length, 1);
});

// ------------------------------------------------------------------ revision ST4
Deno.test("mensajes al usuario/IA: ninguna falla del servicio filtra variables, ids, llaves ni detalles de Wompi", async () => {
  const leaks = /PAYMENTS_|CLIENT_ID|prv_|events_key|private_key|integrity|lxy_|Wompi rechaz|platform_credential|payments_/i;
  // credencial de plataforma ausente (factura), Wompi 422 con detalle, tenant inactivo, comercio sin credencial
  const cases: Array<(w: W) => void> = [
    (w) => { w.credential = null; },
    (w) => { w.wompi.status = 422; w.wompi.body = { error: { messages: { name: ["detalle interno prv_test_X"] } } }; },
    (w) => { w.inactiveMerchants.add(TENANT); },
    (w) => { w.merchants.delete(TENANT); },
    (w) => { w.credential = { mode: "sandbox", privateKey: "k", eventsKey: null }; },
  ];
  for (const mutate of cases) {
    const { w, opts } = await setup();
    mutate(w);
    const e1 = await createSalesOrderPaymentLink(orders(), TENANT, ORDER, null, undefined, opts).then(() => null, (e: Error) => e);
    const e2 = await ensureInvoiceCheckout(fakeAdmin({ payment_invoices: invRows() }), invoice(), null, undefined, opts).then(() => null, (e: Error) => e);
    for (const e of [e1, e2]) if (e) assert(!leaks.test(e.message), `filtra: ${e.message}`);
  }
});

Deno.test("factura: link pendiente con monto distinto -> se reemplaza por uno nuevo y payments_link_id se actualiza", async () => {
  const { w, opts } = await setup();
  const rows = invRows();
  const admin = fakeAdmin({ payment_invoices: rows });
  const first = await ensureInvoiceCheckout(admin, invoice(), null, undefined, opts);
  assert(first.ok);
  const oldId = rows[0].payments_link_id;
  // mismo monto y moneda -> reutiliza
  const same = await ensureInvoiceCheckout(admin, invoice({ payments_link_id: oldId }), null, undefined, opts);
  assert(same.ok && same.checkoutUrl === first.checkoutUrl);
  assertEquals(wompiPosts(w).length, 1);
  // el monto de la factura cambia
  const changed = await ensureInvoiceCheckout(admin, invoice({ payments_link_id: oldId, amount_cents: 23_800_000, tax_cents: 3_800_000 }), null, undefined, opts);
  assert(changed.ok && changed.checkoutUrl !== first.checkoutUrl);
  assertEquals(wompiPosts(w).length, 2);
  assertEquals(w.links[1].amount_in_cents, 23_800_000);
  assert(rows[0].payments_link_id === w.links[1].id && rows[0].payments_link_id !== oldId);
  assertEquals(wompiBody(w, 1).taxes[0].amount_in_cents, 3_800_000);
  // la moneda difiere (el link guardado dice COP; la factura dice USD) -> tambien reemplaza (aqui el servicio rechaza USD: no reutiliza el viejo)
  const cur = await ensureInvoiceCheckout(admin, invoice({ payments_link_id: rows[0].payments_link_id, amount_cents: 23_800_000, currency: "USD" }), null, undefined, opts)
    .then((r) => r, (e: Error) => e);
  assert(cur instanceof Error || (!cur.ok), "moneda distinta nunca reutiliza el link COP");
  assertEquals(wompiPosts(w).length, 2, "y no llego a Wompi");
});

Deno.test("factura: link pagado con factura pendiente -> 409 distinguible (mismo monto vs monto distinto) y log critical", async () => {
  const { w, opts } = await setup();
  const rows = invRows();
  const admin = fakeAdmin({ payment_invoices: rows });
  await ensureInvoiceCheckout(admin, invoice(), null, undefined, opts);
  w.links[0].status = "paid";
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
  let same, diff;
  try {
    same = await ensureInvoiceCheckout(admin, invoice({ payments_link_id: rows[0].payments_link_id }), null, undefined, opts);
    diff = await ensureInvoiceCheckout(admin, invoice({ payments_link_id: rows[0].payments_link_id, amount_cents: 1 }), null, undefined, opts);
  } finally {
    console.log = orig;
  }
  assert(!same.ok && same.status === 409 && /se está confirmando/.test(same.error));
  assert(!diff.ok && diff.status === 409 && /monto distinto/.test(diff.error));
  const crit = logs.filter((l) => l.includes("invoice_link_paid_but_invoice_pending"));
  assertEquals(crit.length, 2);
  assert(crit[0].includes('"terms_match":true') && crit[1].includes('"terms_match":false'));
});

Deno.test("sync: not_applicable / conflict deja log critical con el motivo (no silencioso)", async () => {
  const { w, opts } = await setup();
  const rows = invRows();
  await ensureInvoiceCheckout(fakeAdmin({ payment_invoices: rows }), invoice(), null, undefined, opts);
  w.links[0].status = "paid";
  w.links[0].paid_transaction_id = "tx-1";
  const inv = { id: INVOICE, payer_tenant_id: TENANT, payments_link_id: String(rows[0].payments_link_id) };
  for (const result of ["not_applicable", "conflict"]) {
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
    let out;
    try {
      out = await syncInvoiceFromService(fakeAdmin({}, () => ({ data: { result, reason: "amount_mismatch" }, error: null })), inv, opts);
    } finally {
      console.log = orig;
    }
    assertEquals(out.synced, false);
    assert(logs.some((l) => l.includes("invoice_sync_not_credited") && l.includes(result) && l.includes("amount_mismatch")), logs.join("|"));
  }
});

Deno.test("script de arranque: cliente con ese nombre no interno / suspendido -> codigo != 0 y SIN comando de secretos; el sano -> 0 con el comando", async () => {
  const url = "https://abcdefghij.supabase.co";
  // externo
  let w = newWorld();
  await addClient(w, { name: "Leadly (interno)", kind: "external" });
  let o = renderOutcome(await bootstrapInternalClient(makeDeps(w).rpc, url), "abcdefghij");
  assert(o.code !== 0 && o.out.length === 0 && o.err.length > 0 && !o.err.join("\n").includes("secrets set"));
  // interno suspendido
  w = newWorld();
  const { client } = await addClient(w, { name: "Leadly (interno)", kind: "internal" });
  client.status = "suspended";
  o = renderOutcome(await bootstrapInternalClient(makeDeps(w).rpc, url), "abcdefghij");
  assert(o.code !== 0 && !o.out.join("\n").includes("secrets set"));
  // interno revocado
  w = newWorld();
  const c2 = (await addClient(w, { name: "Leadly (interno)", kind: "internal" })).client;
  c2.revoked_at = new Date().toISOString();
  o = renderOutcome(await bootstrapInternalClient(makeDeps(w).rpc, url), "abcdefghij");
  assert(o.code !== 0 && o.out.length === 0);
  // sano: creado y re-ejecutado
  w = newWorld();
  const r = await bootstrapInternalClient(makeDeps(w).rpc, url);
  o = renderOutcome(r, "abcdefghij");
  assertEquals(o.code, 0);
  assert(o.out.join("\n").includes(`supabase secrets set PAYMENTS_INTERNAL_CLIENT_ID=${r.clientId} --project-ref abcdefghij`));
  const again = renderOutcome(await bootstrapInternalClient(makeDeps(w).rpc, url), "abcdefghij");
  assertEquals(again.code, 0);
});
