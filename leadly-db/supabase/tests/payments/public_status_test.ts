// Ruta publica de estado (GET /v1/public/payment-links/{id}/status) y redirect
// por defecto. Arnes: RPC falso + LegacyStore falso (la version con SQL real vive
// en integration_real.ts seccion 18).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { addClient, addLegacyTarget, createOwnLink, handler, newWorld, req, SECRETS, TENANT_KEYS, wompiEvent } from "./harness.ts";
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

for (const origin of ["invoice", "order_link"] as const) {
  Deno.test(`origen legacy ${origin}: pending -> paid; last_attempt desde los eventos legacy; borrada -> unknown`, async () => {
    const w = newWorld();
    const h = handler(w);
    const t = addLegacyTarget(w, { origin, wompiLinkId: `wl_pub_${origin}` });
    let b = await (await pub(h, t.id)).json();
    assertEquals(Object.keys(b).sort(), EXACT_KEYS);
    assertEquals(b.status, "pending");
    assertEquals(b.last_attempt, null);
    const keys = origin === "invoice" ? { eventsKey: SECRETS.eventsKey } : { eventsKey: TENANT_KEYS.eventsKey };
    if (origin === "invoice") {
      await h(req("POST", "/v1/events/wompi", { body: await wompiEvent({ linkId: t.wompiLinkId, txId: "tx-L-d", status: "DECLINED", amount: 1_500_000, ...keys }) }));
      b = await (await pub(h, t.id)).json();
      assertEquals(b.last_attempt, "DECLINED");
    }
    await h(req("POST", "/v1/events/wompi", { body: await wompiEvent({ linkId: t.wompiLinkId, txId: "tx-L-a", status: "APPROVED", amount: 1_500_000, ...keys }) }));
    b = await (await pub(h, t.id)).json();
    assertEquals(b.status, "paid");
    assertEquals(b.last_attempt, "APPROVED");
    t.deleted = true;
    assertEquals(await (await pub(h, t.id)).json(), UNKNOWN);
  });
}

Deno.test("estados legacy: factura OVERDUE->pending, CANCELLED->cancelled, REFUNDED->voided; link expired", async () => {
  const w = newWorld();
  const h = handler(w);
  for (const [st, exp] of [["OVERDUE", "pending"], ["CANCELLED", "cancelled"], ["REFUNDED", "voided"]]) {
    const t = addLegacyTarget(w, { origin: "invoice", wompiLinkId: `w_${st}`, status: st });
    assertEquals((await (await pub(h, t.id)).json()).status, exp, st);
  }
  const l = addLegacyTarget(w, { origin: "order_link", wompiLinkId: "w_exp", status: "expired" });
  assertEquals((await (await pub(h, l.id)).json()).status, "expired");
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
