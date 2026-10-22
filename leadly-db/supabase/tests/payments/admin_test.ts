import { assert, assertEquals } from "jsr:@std/assert@1";
import { addClient, handler, newWorld, req, SECRETS, validLink } from "./harness.ts";

const ADMIN = { authorization: `Bearer ${SECRETS.adminJwt}` };
const CLIENT_KEYS = ["callback_url", "created_at", "id", "key_prefix", "kind", "name", "revoked_at", "status"];
const errShape = (b: any) => {
  assertEquals(Object.keys(b).sort(), ["error"]);
  assertEquals(Object.keys(b.error).sort(), ["code", "message", "request_id"]);
};

Deno.test("admin sin JWT -> 401, JWT inválido -> 401, no superadmin -> 403 (con forma de error)", async () => {
  const w = newWorld();
  const h = handler(w);
  for (const [hdr, status] of [[undefined, 401], ["Bearer basura", 401], ["Bearer agent-jwt", 403]] as const) {
    const r = await h(req("GET", "/admin/clients", { headers: hdr ? { authorization: hdr } : {} }));
    assertEquals(r.status, status);
    errShape(await r.json());
  }
  // una API key de proyecto tampoco sirve para /admin
  const { apiKey } = await addClient(w);
  const r = await h(req("GET", "/admin/clients", { key: apiKey }));
  assertEquals(r.status, 401);
  assertEquals(w.rpcCalls.length, 0);
});

Deno.test("POST /admin/clients: 201 { client, api_key, signing_secret }, GET lista { items } sin secretos", async () => {
  const w = newWorld();
  const h = handler(w);
  const r = await h(req("POST", "/admin/clients", { headers: ADMIN, body: { name: "Bedly", callback_url: "https://bedly.example.com/pay" } }));
  assertEquals(r.status, 201);
  const b = await r.json();
  assertEquals(Object.keys(b).sort(), ["api_key", "client", "signing_secret"]);
  assertEquals(Object.keys(b.client).sort(), CLIENT_KEYS);
  assert(/^lxy_pay_test_[A-Za-z0-9_-]{8}_[A-Za-z0-9_-]{43}$/.test(b.api_key));
  assert(b.signing_secret.length >= 40);
  // solo el hash quedó guardado, el secreto solo en el vault
  const stored = JSON.stringify(w.clients);
  assert(!stored.includes(b.api_key));
  assert(!stored.includes(b.signing_secret));
  assertEquals(w.clients[0].api_key_hash.length, 64);
  assert([...w.vault.keys()].every((k) => k.startsWith("payments/")));
  assertEquals(w.vault.get(w.clients[0].signing_secret_name), b.signing_secret);
  assertEquals(b.client.key_prefix, b.api_key.slice(0, b.client.key_prefix.length));

  const l = await h(req("GET", "/admin/clients?forceFunctionRegion=us-west-2", { headers: ADMIN }));
  assertEquals(l.status, 200);
  const lb = await l.json();
  assertEquals(Object.keys(lb), ["items"]);
  assertEquals(Object.keys(lb.items[0]).sort(), CLIENT_KEYS);
  const txt = JSON.stringify(lb);
  assert(!txt.includes(b.api_key) && !txt.includes(w.clients[0].api_key_hash) && !txt.includes("signing"));

  // la clave recién creada autentica en /v1
  const g = await h(req("GET", "/v1/payment-links?external_reference=nada", { key: b.api_key }));
  assertEquals(g.status, 404); // autenticó (404 de recurso, no 401)
});

Deno.test("POST /admin/clients: callback privada -> 422; nombre repetido -> 409; sin credencial -> 409", async () => {
  const w = newWorld();
  const h = handler(w);
  let r = await h(req("POST", "/admin/clients", { headers: ADMIN, body: { name: "X", callback_url: "https://192.168.1.10/h" } }));
  assertEquals(r.status, 422);
  assertEquals((await r.json()).error.code, "invalid_callback_url");
  r = await h(req("POST", "/admin/clients", { headers: ADMIN, body: { name: "Dup" } }));
  assertEquals(r.status, 201);
  r = await h(req("POST", "/admin/clients", { headers: ADMIN, body: { name: "Dup" } }));
  assertEquals(r.status, 409);
  w.credential = null;
  r = await h(req("POST", "/admin/clients", { headers: ADMIN, body: { name: "Otro" } }));
  assertEquals(r.status, 409);
  assertEquals((await r.json()).error.code, "platform_credential_missing");
  assertEquals(w.clients.length, 1);
});

Deno.test("rotate-key: 200 { client, api_key }; la clave vieja deja de servir", async () => {
  const w = newWorld();
  const h = handler(w);
  const created = await (await h(req("POST", "/admin/clients", { headers: ADMIN, body: { name: "R" } }))).json();
  const oldKey = created.api_key;
  const secretBefore = w.vault.get(w.clients[0].signing_secret_name);
  const r = await h(req("POST", `/admin/clients/${created.client.id}/rotate-key`, { headers: ADMIN }));
  assertEquals(r.status, 200);
  const b = await r.json();
  assertEquals(Object.keys(b).sort(), ["api_key", "client"]);
  assertEquals(Object.keys(b.client).sort(), CLIENT_KEYS);
  assert(b.api_key !== oldKey);
  assertEquals(w.vault.get(w.clients[0].signing_secret_name), secretBefore);
  assertEquals((await h(req("GET", "/v1/payment-links?external_reference=a", { key: oldKey }))).status, 401);
  assertEquals((await h(req("GET", "/v1/payment-links?external_reference=a", { key: b.api_key }))).status, 404);
});

Deno.test("PATCH: status y callback_url -> 200 { client }; suspender bloquea la clave", async () => {
  const w = newWorld();
  const h = handler(w);
  const created = await (await h(req("POST", "/admin/clients", { headers: ADMIN, body: { name: "P" } }))).json();
  const id = created.client.id;
  let r = await h(req("PATCH", `/admin/clients/${id}`, { headers: ADMIN, body: { status: "suspended", callback_url: "https://p.example.com/cb" } }));
  assertEquals(r.status, 200);
  let b = await r.json();
  assertEquals(Object.keys(b), ["client"]);
  assertEquals(Object.keys(b.client).sort(), CLIENT_KEYS);
  assertEquals(b.client.status, "suspended");
  assertEquals(b.client.callback_url, "https://p.example.com/cb");
  assertEquals((await h(req("GET", "/v1/payment-links?external_reference=a", { key: created.api_key }))).status, 401);
  r = await h(req("PATCH", `/admin/clients/${id}`, { headers: ADMIN, body: { status: "revoked" } }));
  assertEquals(r.status, 422);
  r = await h(req("PATCH", `/admin/clients/${id}`, { headers: ADMIN, body: { callback_url: "https://localhost/x" } }));
  assertEquals(r.status, 422);
  r = await h(req("PATCH", `/admin/clients/${id}`, { headers: ADMIN, body: { status: "active", api_key: "x" } }));
  assertEquals(r.status, 422);
  r = await h(req("PATCH", `/admin/clients/${crypto.randomUUID()}`, { headers: ADMIN, body: { status: "active" } }));
  assertEquals(r.status, 404);
  b = await (await h(req("PATCH", `/admin/clients/${id}`, { headers: ADMIN, body: { status: "active" } }))).json();
  assertEquals(b.client.status, "active");
});

Deno.test("POST /admin/links: 201 con la forma de /v1, replay 200, a nombre del proyecto y created_by = usuario", async () => {
  const w = newWorld();
  const h = handler(w);
  const c = await (await h(req("POST", "/admin/clients", { headers: ADMIN, body: { name: "L" } }))).json();
  const body = { client_id: c.client.id, idempotency_key: "adm-1", ...validLink() };
  let r = await h(req("POST", "/admin/links", { headers: ADMIN, body }));
  assertEquals(r.status, 201);
  const b = await r.json();
  assertEquals(b.status, "pending");
  assert(b.checkout_url.startsWith("https://checkout.wompi.co/l/"));
  assertEquals(w.links[0].client_id, c.client.id);
  assertEquals(w.links[0].created_by, "11111111-1111-4111-8111-111111111111");
  r = await h(req("POST", "/admin/links", { headers: ADMIN, body }));
  assertEquals(r.status, 200);
  assertEquals((await r.json()).id, b.id);
  assertEquals(w.wompi.created, 1);
  // proyecto suspendido -> 409; campo prohibido -> 422; sin idempotency_key -> 400
  w.clients[0].status = "suspended";
  r = await h(req("POST", "/admin/links", { headers: ADMIN, body: { ...body, idempotency_key: "adm-2" } }));
  assertEquals(r.status, 409);
  w.clients[0].status = "active";
  r = await h(req("POST", "/admin/links", { headers: ADMIN, body: { ...body, idempotency_key: "adm-3", environment: "production" } }));
  assertEquals(r.status, 422);
  r = await h(req("POST", "/admin/links", { headers: ADMIN, body: { ...body, idempotency_key: undefined } }));
  assertEquals(r.status, 400);
});

Deno.test("GET /admin/links: { items[...forma fija], next_before }, ignora query desconocida", async () => {
  const w = newWorld();
  const h = handler(w);
  const c = await (await h(req("POST", "/admin/clients", { headers: ADMIN, body: { name: "Lista" } }))).json();
  await h(req("POST", "/admin/links", { headers: ADMIN, body: { client_id: c.client.id, idempotency_key: "k", ...validLink() } }));
  const r = await h(req("GET", `/admin/links?client_id=${c.client.id}&status=pending&forceFunctionRegion=us-west-2`, { headers: ADMIN }));
  assertEquals(r.status, 200);
  const b = await r.json();
  assertEquals(Object.keys(b).sort(), ["items", "next_before"]);
  assertEquals(b.next_before, null);
  assertEquals(Object.keys(b.items[0]).sort(), [
    "amount_in_cents", "checkout_url", "client_id", "client_name", "created_at", "currency", "environment",
    "external_reference", "id", "paid_at", "status",
  ]);
  assertEquals(b.items[0].client_name, "Lista");
  const bad = await h(req("GET", "/admin/links?status=raro", { headers: ADMIN }));
  assertEquals(bad.status, 422);
});

Deno.test("GET /admin/readiness: forma fija; configured false sin events_key; modo null sin credencial", async () => {
  const w = newWorld();
  const h = handler(w);
  await addClient(w);
  let r = await h(req("GET", "/admin/readiness?forceFunctionRegion=us-west-2", { headers: ADMIN }));
  assertEquals(r.status, 200);
  let b = await r.json();
  assertEquals(Object.keys(b).sort(), ["clients_active", "events_url", "health", "platform_credential"]);
  assertEquals(b.health, w.healthSummary);
  assertEquals(b.platform_credential, { configured: true, mode: "sandbox" });
  assertEquals(b.events_url, "https://proj.supabase.co/functions/v1/payments-api/v1/events/wompi");
  assertEquals(b.clients_active, 1);
  w.credential!.eventsKey = null;
  b = await (await h(req("GET", "/admin/readiness", { headers: ADMIN }))).json();
  assertEquals(b.platform_credential, { configured: false, mode: "sandbox" });
  w.credential = null;
  b = await (await h(req("GET", "/admin/readiness", { headers: ADMIN }))).json();
  assertEquals(b.platform_credential, { configured: false, mode: null });
  assert(!JSON.stringify(b).includes(SECRETS.eventsKey));
});

Deno.test("CORS solo en /admin: OPTIONS 204 con métodos y headers acordados; errores también llevan CORS", async () => {
  const w = newWorld();
  const h = handler(w);
  const o = await h(req("OPTIONS", "/admin/clients"));
  assertEquals(o.status, 204);
  assertEquals(o.headers.get("access-control-allow-methods"), "GET, POST, PATCH, OPTIONS");
  const hdrs = o.headers.get("access-control-allow-headers")!.split(",").map((x) => x.trim());
  for (const x of ["authorization", "x-client-info", "apikey", "content-type", "idempotency-key"]) assert(hdrs.includes(x), x);
  assert(o.headers.get("access-control-allow-origin"));
  const e = await h(req("GET", "/admin/clients"));
  assertEquals(e.status, 401);
  assert(e.headers.get("access-control-allow-origin"));
  assertEquals((await h(req("OPTIONS", "/internal/dispatch"))).headers.get("access-control-allow-origin"), null);
});

Deno.test("ruta inexistente -> 404 con forma de error", async () => {
  const w = newWorld();
  const h = handler(w);
  const r = await h(req("GET", "/admin/nada", { headers: ADMIN }));
  assertEquals(r.status, 404);
  errShape(await r.json());
  const r2 = await h(req("GET", "/otra/cosa"));
  assertEquals(r2.status, 404);
});
