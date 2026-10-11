import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { addClient, createOwnLink, handler, newWorld, req, SECRETS, validLink } from "./harness.ts";

Deno.test("health sin auth responde 200", async () => {
  const w = newWorld();
  const r = await handler(w)(req("GET", "/v1/health"));
  assertEquals(r.status, 200);
  assertEquals((await r.json()).status, "ok");
  assert(r.headers.get("x-request-id"));
});

Deno.test("sin API key -> 401 con cuerpo propio {error:{code,message,request_id}}", async () => {
  const w = newWorld();
  const r = await handler(w)(req("GET", "/v1/payment-links?external_reference=x"));
  assertEquals(r.status, 401);
  const b = await r.json();
  assertEquals(b.error.code, "unauthorized");
  assertEquals(typeof b.error.message, "string");
  assertEquals(b.error.request_id, r.headers.get("x-request-id"));
});

Deno.test("API key malformada se rechaza sin consultar la base; revocada -> 401", async () => {
  const w = newWorld();
  const h = handler(w);
  let r = await h(req("GET", "/v1/payment-links/abc", { key: "lxy_pay_test_short" }));
  assertEquals(r.status, 401);
  assertEquals(w.rpcCalls.length, 0);
  const { client, apiKey } = await addClient(w);
  client.revoked_at = new Date().toISOString();
  client.status = "suspended";
  r = await h(req("GET", "/v1/payment-links?external_reference=x", { key: apiKey }));
  assertEquals(r.status, 401);
  assertEquals((await r.json()).error.code, "unauthorized");
});

Deno.test("crear link: 201, cuerpo a Wompi sin taxes, sku = id interno, single_use, description", async () => {
  const w = newWorld();
  const { apiKey } = await addClient(w);
  const h = handler(w);
  const { res, body } = await createOwnLink(w, h, apiKey);
  assertEquals(res.status, 201);
  assertEquals(Object.keys(body).sort(), [
    "amount_in_cents", "checkout_url", "created_at", "currency", "environment", "expires_at", "external_reference", "id",
    "last_event", "metadata", "paid_at", "paid_transaction_id", "status", "status_detail", "updated_at",
  ].sort());
  assertEquals(body.status, "pending");
  assert(body.checkout_url.startsWith("https://checkout.wompi.co/l/"));
  assertEquals(body.environment, "sandbox");
  const call = w.fetchCalls.find((c) => c.url.endsWith("/payment_links"))!;
  assertEquals(call.url, "https://sandbox.wompi.co/v1/payment_links");
  const sent = JSON.parse(call.init.body as string);
  assertEquals("taxes" in sent, false);
  assertEquals(sent.sku, body.id);
  assertEquals(sent.single_use, true);
  assertEquals(sent.collect_shipping, false);
  assertEquals(sent.description, "Plan Pro octubre");
  assertEquals(sent.amount_in_cents, 1_500_000);
  assertEquals((call.init.headers as Record<string, string>).Authorization, `Bearer ${SECRETS.privateKey}`);
  assert(!JSON.stringify(body).includes(SECRETS.privateKey));
});

Deno.test("taxes explícitos se envían tal cual", async () => {
  const w = newWorld();
  const { apiKey } = await addClient(w);
  const { res } = await createOwnLink(w, handler(w), apiKey, { taxes: [{ type: "CONSUMPTION", amount_in_cents: 111_111 }] });
  assertEquals(res.status, 201);
  const sent = JSON.parse(w.fetchCalls.find((c) => c.url.endsWith("/payment_links"))!.init.body as string);
  assertEquals(sent.taxes, [{ type: "CONSUMPTION", amount_in_cents: 111_111 }]);
});

Deno.test("idempotencia: replay 200 sin nueva llamada a Wompi; otro cuerpo -> 409", async () => {
  const w = newWorld();
  const { apiKey } = await addClient(w);
  const h = handler(w);
  const idem = "key-123";
  const a = await h(req("POST", "/v1/payment-links", { key: apiKey, headers: { "idempotency-key": idem }, body: validLink() }));
  const b = await h(req("POST", "/v1/payment-links", { key: apiKey, headers: { "idempotency-key": idem }, body: validLink() }));
  assertEquals(a.status, 201);
  assertEquals(b.status, 200);
  assertEquals((await a.json()).id, (await b.json()).id);
  assertEquals(w.wompi.created, 1);
  const c = await h(req("POST", "/v1/payment-links", { key: apiKey, headers: { "idempotency-key": idem }, body: validLink({ amount_in_cents: 5 }) }));
  assertEquals(c.status, 409);
  assertEquals((await c.json()).error.code, "idempotency_key_reused");
  assertEquals(w.wompi.created, 1);
});

Deno.test("Idempotency-Key obligatoria y con formato", async () => {
  const w = newWorld();
  const { apiKey } = await addClient(w);
  const h = handler(w);
  for (const k of [undefined, "", "con espacio", "x".repeat(129)]) {
    const r = await h(req("POST", "/v1/payment-links", { key: apiKey, headers: k === undefined ? {} : { "idempotency-key": k }, body: validLink() }));
    assertEquals(r.status, 400, String(k));
    assertEquals((await r.json()).error.code, "invalid_idempotency_key");
  }
  assertEquals(w.wompi.created, 0);
});

Deno.test("campos prohibidos y validaciones del body -> 422", async () => {
  const w = newWorld();
  const { apiKey } = await addClient(w);
  const h = handler(w);
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ client_id: "x" }, "field_not_allowed"],
    [{ account: "x" }, "field_not_allowed"],
    [{ environment: "production" }, "field_not_allowed"],
    [{ single_use: false }, "field_not_allowed"],
    [{ currency: "USD" }, "currency_not_supported"],
    [{ amount_in_cents: 0 }, "invalid_amount"],
    [{ amount_in_cents: 10.5 }, "invalid_amount"],
    [{ description: "" }, "invalid_field"],
    [{ description: undefined }, "invalid_field"],
    [{ redirect_url: "http://insegura.example.com" }, "invalid_redirect_url"],
    [{ expires_at: "2020-01-01T00:00:00Z" }, "invalid_expires_at"],
    [{ taxes: [{ type: "VAT", amount_in_cents: 99_999_999 }] }, "invalid_taxes"],
  ];
  for (const [over, code] of cases) {
    const r = await h(req("POST", "/v1/payment-links", { key: apiKey, headers: { "idempotency-key": crypto.randomUUID() }, body: validLink(over) }));
    assertEquals(r.status, 422, JSON.stringify(over));
    assertEquals((await r.json()).error.code, code, JSON.stringify(over));
  }
  assertEquals(w.wompi.created, 0);
  assertEquals(w.links.length, 0);
});

Deno.test("Wompi 422 -> 422 provider_rejected y el link queda en error; 500 -> 502", async () => {
  const w = newWorld();
  const { apiKey } = await addClient(w);
  const h = handler(w);
  w.wompi.status = 422;
  w.wompi.body = { error: { type: "INPUT_VALIDATION_ERROR", messages: { description: ["No está presente"] } } };
  let r = await h(req("POST", "/v1/payment-links", { key: apiKey, headers: { "idempotency-key": "a1" }, body: validLink() }));
  assertEquals(r.status, 422);
  assertEquals((await r.json()).error.code, "provider_rejected");
  assertEquals(w.links[0].status, "error");
  w.wompi.status = 500;
  w.wompi.body = { error: "x" };
  r = await h(req("POST", "/v1/payment-links", { key: apiKey, headers: { "idempotency-key": "a2" }, body: validLink() }));
  assertEquals(r.status, 502);
  assertEquals(w.links[1].status, "error");
});

Deno.test("timeout hacia Wompi -> 502 y link en error (resultado desconocido documentado)", async () => {
  const w = newWorld();
  const { apiKey } = await addClient(w);
  w.wompi.throws = "abort";
  const r = await handler(w)(req("POST", "/v1/payment-links", { key: apiKey, headers: { "idempotency-key": "t1" }, body: validLink() }));
  assertEquals(r.status, 502);
  assertEquals(w.links[0].status, "error");
  assert(String(w.links[0].status_detail).includes("unknown_outcome"));
});

Deno.test("key live con credencial sandbox -> 409 environment_unavailable; sin credencial -> 503", async () => {
  const w = newWorld();
  const { apiKey } = await addClient(w, { env: "production" });
  const h = handler(w);
  let r = await h(req("POST", "/v1/payment-links", { key: apiKey, headers: { "idempotency-key": "e1" }, body: validLink() }));
  assertEquals(r.status, 409);
  assertEquals((await r.json()).error.code, "environment_unavailable");
  w.credential = null;
  r = await h(req("POST", "/v1/payment-links", { key: apiKey, headers: { "idempotency-key": "e2" }, body: validLink() }));
  assertEquals(r.status, 503);
  assertEquals(w.wompi.created, 0);
});

Deno.test("GET por id y por external_reference; un proyecto no ve links de otro", async () => {
  const w = newWorld();
  const a = await addClient(w, { name: "A" });
  const b = await addClient(w, { name: "B" });
  const h = handler(w);
  const { body } = await createOwnLink(w, h, a.apiKey, { external_reference: "ref-A" });
  let r = await h(req("GET", `/v1/payment-links/${body.id}`, { key: a.apiKey }));
  assertEquals(r.status, 200);
  assertEquals((await r.json()).external_reference, "ref-A");
  r = await h(req("GET", "/v1/payment-links?external_reference=ref-A", { key: a.apiKey }));
  assertEquals(r.status, 200);
  r = await h(req("GET", `/v1/payment-links/${body.id}`, { key: b.apiKey }));
  assertEquals(r.status, 404);
  r = await h(req("GET", "/v1/payment-links?external_reference=ref-A", { key: b.apiKey }));
  assertEquals(r.status, 404);
  r = await h(req("GET", "/v1/payment-links/no-es-uuid", { key: a.apiKey }));
  assertEquals(r.status, 404);
  r = await h(req("GET", "/v1/payment-links", { key: a.apiKey }));
  assertEquals(r.status, 422);
  assertNotEquals(r.status, 500);
});

Deno.test("sin CORS en /v1 ni /internal; OPTIONS no permitido", async () => {
  const w = newWorld();
  const h = handler(w);
  const r = await h(req("GET", "/v1/health"));
  assertEquals(r.headers.get("access-control-allow-origin"), null);
  const o = await h(req("OPTIONS", "/v1/payment-links"));
  assertEquals(o.status, 405);
  assertEquals(o.headers.get("access-control-allow-origin"), null);
});
