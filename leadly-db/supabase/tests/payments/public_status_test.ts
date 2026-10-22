// Ruta publica de estado (GET /v1/public/payment-links/{id}/status) y redirect
// por defecto. Arnes: RPC falso (la version con SQL real vive en integration_real.ts
// seccion 18). Sin fallback: solo existen los links de payments.payment_links.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { addClient, createOwnLink, handler, newWorld, req, wompiEvent } from "./harness.ts";
import { paymentReturnUrl, resolvePublicAppUrl, DEFAULT_PUBLIC_APP_URL } from "../../functions/_shared/publicAppUrl.ts";

const EXACT_KEYS = ["last_attempt", "status", "updated_at"];
const pub = (h: (r: Request) => Promise<Response>, id: string, method = "GET") =>
  h(new Request(`https://proj.supabase.co/functions/v1/payments-api/v1/public/payment-links/${id}/status`, { method }));
const UNKNOWN = { status: "unknown", last_attempt: null, updated_at: null };

Deno.test("forma EXACTA: solo status/last_attempt/updated_at, sin Authorization, no-store, CORS GET/OPTIONS", async () => {
  const w = newWorld();
  const { apiKey } = await addClient(w);
  const h = handler(w);
  const { body } = await createOwnLink(w, h, apiKey);
  const r = await pub(h, body.id);
  assertEquals(r.status, 200);
  const b = await r.json();
  assertEquals(Object.keys(b).sort(), EXACT_KEYS);
  assertEquals(b.status, "pending");
  assertEquals(b.last_attempt, null);
  assertEquals(typeof b.updated_at, "string");
  assertEquals(r.headers.get("cache-control"), "no-store");
  assertEquals(r.headers.get("access-control-allow-origin"), "*");
  assertEquals(r.headers.get("access-control-allow-methods"), "GET, OPTIONS");
  // nada sensible, ni siquiera en el texto crudo
  const raw = JSON.stringify(b);
  for (const needle of [String(body.amount_in_cents), "ORD", "inv-001", "Plan Pro", "wl", "client", "wompi", "checkout"]) {
    assert(!raw.includes(needle), `no debe filtrar ${needle}`);
  }
});

Deno.test("OPTIONS publico 204 con CORS; POST -> 405; ruta distinta -> 404", async () => {
  const h = handler(newWorld());
  const id = crypto.randomUUID();
  const o = await pub(h, id, "OPTIONS");
  assertEquals(o.status, 204);
  assertEquals(o.headers.get("access-control-allow-methods"), "GET, OPTIONS");
  assertEquals((await pub(h, id, "POST")).status, 405);
  const r = await h(new Request("https://proj.supabase.co/functions/v1/payments-api/v1/public/otra"));
  assertEquals(r.status, 404);
});

Deno.test("id inexistente o mal formado -> 200 con EL MISMO cuerpo unknown, sin consultar la base si es mal formado", async () => {
  const w = newWorld();
  const h = handler(w);
  const missing = await pub(h, crypto.randomUUID());
  assertEquals(missing.status, 200);
  assertEquals(await missing.json(), UNKNOWN);
  const before = w.rpcCalls.length;
  for (const bad of ["abc", "123", "not-a-uuid", "00000000-0000-0000-0000-00000000000z", encodeURIComponent("' or 1=1 --")]) {
    const r = await pub(h, bad);
    assertEquals(r.status, 200, bad);
    assertEquals(await r.json(), UNKNOWN, bad);
  }
  assertEquals(w.rpcCalls.length, before, "id mal formado no toca la base");
});

Deno.test("link del servicio nuevo: paid / voided / expired / error y creating->pending", async () => {
  const w = newWorld();
  const { apiKey } = await addClient(w);
  const h = handler(w);
  const { body } = await createOwnLink(w, h, apiKey);
  const l = w.links.find((x) => x.id === body.id)!;
  for (const [native, expected] of [["creating", "pending"], ["paid", "paid"], ["voided", "voided"], ["expired", "expired"], ["cancelled", "cancelled"], ["error", "error"]]) {
    l.status = native;
    assertEquals((await (await pub(h, body.id)).json()).status, expected, native);
  }
  l.status = "algo_raro";
  assertEquals((await (await pub(h, body.id.toUpperCase())).json()).status, "unknown");
});

Deno.test("last_attempt sale del ultimo evento valido (processed): APPROVED / DECLINED; null sin eventos", async () => {
  const w = newWorld();
  const { apiKey } = await addClient(w);
  const h = handler(w);
  const { body } = await createOwnLink(w, h, apiKey);
  const wl = w.links.find((x) => x.id === body.id)!.wompi_link_id;
  assertEquals((await (await pub(h, body.id)).json()).last_attempt, null);
  const dec = await wompiEvent({ linkId: wl, txId: "tx-d1", status: "DECLINED", amount: 1_500_000 });
  await h(req("POST", "/v1/events/wompi", { body: dec }));
  let b = await (await pub(h, body.id)).json();
  assertEquals(b.status, "pending");
  assertEquals(b.last_attempt, "DECLINED");
  const ok = await wompiEvent({ linkId: wl, txId: "tx-a1", status: "APPROVED", amount: 1_500_000 });
  await h(req("POST", "/v1/events/wompi", { body: ok }));
  b = await (await pub(h, body.id)).json();
  assertEquals(b.status, "paid");
  assertEquals(b.last_attempt, "APPROVED");
  assertEquals(Object.keys(b).sort(), EXACT_KEYS);
});

Deno.test("un evento de firma invalida NO cambia last_attempt (no se puede falsear desde fuera)", async () => {
  const w = newWorld();
  const { apiKey } = await addClient(w);
  const h = handler(w);
  const { body } = await createOwnLink(w, h, apiKey);
  const wl = w.links.find((x) => x.id === body.id)!.wompi_link_id;
  const bad = await wompiEvent({ linkId: wl, txId: "tx-x", status: "DECLINED", amount: 1_500_000, eventsKey: "otra-clave" });
  const r = await h(req("POST", "/v1/events/wompi", { body: bad }));
  assertEquals(r.status, 401);
  assertEquals((await (await pub(h, body.id)).json()).last_attempt, null);
});

Deno.test("sin fallback: un uuid que no es de payments.payment_links (p. ej. una factura/link de pedido ex-legacy) responde el MISMO unknown que uno inexistente", async () => {
  const w = newWorld();
  const { apiKey } = await addClient(w);
  const h = handler(w);
  await createOwnLink(w, h, apiKey); // hay datos propios: el unknown no depende de que la base este vacia
  const exLegacy = crypto.randomUUID(); // id de una fila que existio en public.payment_invoices / sales_order_payment_links
  const never = crypto.randomUUID();
  const a = await pub(h, exLegacy);
  const b = await pub(h, never);
  assertEquals(a.status, 200);
  assertEquals(b.status, 200);
  assertEquals(await a.json(), UNKNOWN);
  assertEquals(await b.json(), UNKNOWN);
  // una sola consulta por peticion: el RPC propio; ninguna otra rama de lectura
  const calls = w.rpcCalls.filter((c) => c.fn === "payments_public_link_status");
  assertEquals(calls.length, 2);
  assertEquals(w.rpcCalls.filter((c) => c.fn.includes("legacy")).length, 0);
});

Deno.test("estados nativos: expired y cancelled se publican tal cual, creating como pending", async () => {
  const w = newWorld();
  const { apiKey } = await addClient(w);
  const h = handler(w);
  const { body } = await createOwnLink(w, h, apiKey);
  const l = w.links.find((x) => x.id === body.id)!;
  for (const [st, exp] of [["expired", "expired"], ["cancelled", "cancelled"], ["creating", "pending"], ["voided", "voided"]]) {
    l.status = st;
    assertEquals((await (await pub(h, body.id)).json()).status, exp, st);
  }
});

Deno.test("la ruta publica NO acepta el id de Wompi ni requiere/usa API key", async () => {
  const w = newWorld();
  const { apiKey } = await addClient(w);
  const h = handler(w);
  const { body } = await createOwnLink(w, h, apiKey);
  const wl = w.links.find((x) => x.id === body.id)!.wompi_link_id;
  assertEquals(await (await pub(h, wl)).json(), UNKNOWN);
});

// ---- redirect por defecto -------------------------------------------------

Deno.test("redirect por defecto: sin redirect_url, Wompi recibe /pago/resultado?link=<id del link>", async () => {
  const w = newWorld();
  const { apiKey } = await addClient(w);
  const h = handler(w);
  const { res, body } = await createOwnLink(w, h, apiKey, { redirect_url: undefined });
  assertEquals(res.status, 201);
  const sent = JSON.parse(w.fetchCalls.find((c) => c.url.endsWith("/payment_links"))!.init.body as string);
  assertEquals(sent.redirect_url, `${DEFAULT_PUBLIC_APP_URL}/pago/resultado?link=${body.id}`);
});

Deno.test("redirect explicito del proyecto SIEMPRE gana sobre el default", async () => {
  const w = newWorld();
  const { apiKey } = await addClient(w);
  const h = handler(w);
  const { res } = await createOwnLink(w, h, apiKey, { redirect_url: "https://proyecto.example.com/gracias" });
  assertEquals(res.status, 201);
  const sent = JSON.parse(w.fetchCalls.find((c) => c.url.endsWith("/payment_links"))!.init.body as string);
  assertEquals(sent.redirect_url, "https://proyecto.example.com/gracias");
});

Deno.test("redirect por defecto usa env.appBaseUrl cuando esta configurado", async () => {
  const w = newWorld();
  const { apiKey } = await addClient(w);
  const base = handler(w, { env: { supabaseUrl: "https://proj.supabase.co", cronSecret: "c", appBaseUrl: "https://app.otro.example/" } });
  const { body } = await createOwnLink(w, base, apiKey, { redirect_url: undefined });
  const sent = JSON.parse(w.fetchCalls.find((c) => c.url.endsWith("/payment_links"))!.init.body as string);
  assertEquals(sent.redirect_url, `https://app.otro.example/pago/resultado?link=${body.id}`);
});

Deno.test("publicAppUrl: base invalida / http / con credenciales cae al default; sin barra final", () => {
  assertEquals(resolvePublicAppUrl(undefined), DEFAULT_PUBLIC_APP_URL);
  assertEquals(resolvePublicAppUrl("http://inseguro.example"), DEFAULT_PUBLIC_APP_URL);
  assertEquals(resolvePublicAppUrl("https://u:p@x.example"), DEFAULT_PUBLIC_APP_URL);
  assertEquals(resolvePublicAppUrl("no es url"), DEFAULT_PUBLIC_APP_URL);
  assertEquals(resolvePublicAppUrl("https://app.example.com///"), "https://app.example.com");
  assertEquals(paymentReturnUrl("abc", "https://app.example.com/"), "https://app.example.com/pago/resultado?link=abc");
});
