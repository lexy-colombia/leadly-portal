// ST2: comercio (merchant_tenant_id). Cliente interno vs externo, credencial del
// comercio (falla cerrado), verificacion de eventos con la events_key / private_key
// del comercio del link.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { createPaymentLink, validateLinkRequest } from "../../functions/_shared/payments-service/wompiLinks.ts";
import { ApiError, mapRpcError } from "../../functions/_shared/payments-service/errors.ts";
import { addClient, captureLogs, createOwnLink, handler, makeDeps, MERCHANT_KEYS, newWorld, req, SECRETS, validLink, wompiEvent } from "./harness.ts";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
type W = ReturnType<typeof newWorld>;

const request = (over: Record<string, unknown> = {}) => validateLinkRequest(validLink(over), Date.now());
const create = (w: W, clientId: string, o: { merchant?: string | null; idem?: string; environment?: "sandbox" | "production" | null; req?: Record<string, unknown> } = {}) =>
  createPaymentLink(makeDeps(w), {
    clientId,
    createdBy: null,
    environment: o.environment === undefined ? null : o.environment,
    idempotencyKey: o.idem ?? crypto.randomUUID(),
    request: request(o.req),
    merchantTenantId: o.merchant,
  });
const rejection = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof ApiError) return e;
    throw e;
  }
  throw new Error("se esperaba un ApiError");
};
const wompiPosts = (w: W) => w.fetchCalls.filter((c) => c.url.endsWith("/payment_links"));
const auth = (c: { init: RequestInit }) => (c.init.headers as Record<string, string>).Authorization;
const merchantCred = (mode: "sandbox" | "production" = "sandbox") => ({ mode, privateKey: MERCHANT_KEYS.privateKey, eventsKey: MERCHANT_KEYS.eventsKey });

Deno.test("cliente externo con merchant / merchant_tenant_id en el cuerpo -> 422 field_not_allowed, sin tocar la base", async () => {
  const w = newWorld();
  const { apiKey } = await addClient(w);
  const h = handler(w);
  for (const field of ["merchant", "merchant_tenant_id"]) {
    const r = await h(req("POST", "/v1/payment-links", { key: apiKey, headers: { "idempotency-key": crypto.randomUUID() }, body: validLink({ [field]: TENANT }) }));
    assertEquals(r.status, 422);
    assertEquals((await r.json()).error.code, "field_not_allowed");
  }
  assertEquals(w.rpcCalls.filter((c) => c.fn === "payments_begin_link").length, 0);
  assertEquals(wompiPosts(w).length, 0);
});

Deno.test("cliente externo que logra pedir comercio en proceso -> 403 merchant_not_allowed (distinto de proyecto no activo), sin llamar a Wompi", async () => {
  const w = newWorld();
  w.merchants.set(TENANT, merchantCred());
  const { client } = await addClient(w, { kind: "external" });
  const e = await rejection(create(w, String(client.id), { merchant: TENANT }));
  assertEquals(e.status, 403);
  assertEquals(e.code, "merchant_not_allowed");
  assertEquals(wompiPosts(w).length, 0);
  assertEquals(w.links.length, 0);
  // "proyecto no activo" sigue siendo 409 invalid_state
  const inactive = mapRpcError("payments_begin_link", { code: "PY423", message: "proyecto no activo" });
  assertEquals([inactive.status, inactive.code], [409, "invalid_state"]);
});

Deno.test("interno con comercio: usa la credencial DEL COMERCIO (ambiente, llave privada) y guarda merchant_tenant_id", async () => {
  const w = newWorld(); // plataforma = sandbox
  w.merchants.set(TENANT, merchantCred("production"));
  const { client } = await addClient(w, { kind: "internal" });
  const r = await create(w, String(client.id), { merchant: TENANT });
  assertEquals(r.link.environment, "production");
  assertEquals(r.link.merchant_tenant_id, TENANT);
  const posts = wompiPosts(w);
  assertEquals(posts.length, 1);
  assertEquals(posts[0].url, "https://production.wompi.co/v1/payment_links");
  assertEquals(auth(posts[0]), `Bearer ${MERCHANT_KEYS.privateKey}`);
  assert(!auth(posts[0]).includes(SECRETS.privateKey), "nunca la llave de plataforma");
});

Deno.test("interno con comercio SIN credencial: falla cerrada (409 merchant_credential_unavailable), link en error, ninguna llamada a Wompi", async () => {
  const w = newWorld(); // la plataforma SI tiene credencial: no debe usarse
  const { client } = await addClient(w, { kind: "internal" });
  const e = await rejection(create(w, String(client.id), { merchant: TENANT }));
  assertEquals([e.status, e.code], [409, "merchant_credential_unavailable"]);
  assertEquals(w.links.length, 1);
  assertEquals(w.links[0].status, "error");
  assertEquals(w.links[0].status_detail, "merchant_credential_unavailable");
  assertEquals(w.links[0].merchant_tenant_id, TENANT);
  assertEquals(w.fetchCalls.length, 0);
});

Deno.test("interno con comercio cuya credencial no trae llave privada: falla cerrada, link en error", async () => {
  const w = newWorld();
  w.merchants.set(TENANT, { mode: "sandbox", privateKey: null, eventsKey: MERCHANT_KEYS.eventsKey });
  const { client } = await addClient(w, { kind: "internal" });
  const e = await rejection(create(w, String(client.id), { merchant: TENANT }));
  assertEquals(e.code, "merchant_credential_unavailable");
  assertEquals(w.links[0].status, "error");
  assertEquals(w.fetchCalls.length, 0);
});

Deno.test("getMerchantCredential que lanza -> mismo cierre (no cae a plataforma)", async () => {
  const w = newWorld();
  const { client } = await addClient(w, { kind: "internal" });
  const deps = makeDeps(w, { getMerchantCredential: () => Promise.reject(new Error("vault caido")) });
  const e = await rejection(createPaymentLink(deps, { clientId: String(client.id), createdBy: null, environment: null, idempotencyKey: "k-throw", request: request(), merchantTenantId: TENANT }));
  assertEquals(e.code, "merchant_credential_unavailable");
  assertEquals(w.fetchCalls.length, 0);
});

Deno.test("interno SIN comercio = plataforma, igual que antes (credencial de plataforma, sin merchant)", async () => {
  const w = newWorld();
  const { client } = await addClient(w, { kind: "internal" });
  const r = await create(w, String(client.id), {});
  assertEquals(r.link.merchant_tenant_id, null);
  assertEquals(auth(wompiPosts(w)[0]), `Bearer ${SECRETS.privateKey}`);
});

Deno.test("merchant_tenant_id que no es uuid -> 422 invalid_merchant", async () => {
  const w = newWorld();
  const { client } = await addClient(w, { kind: "internal" });
  const e = await rejection(create(w, String(client.id), { merchant: "no-es-uuid" }));
  assertEquals([e.status, e.code], [422, "invalid_merchant"]);
  assertEquals(w.links.length, 0);
});

Deno.test("idempotencia: mismo comercio -> replay; otro comercio o sin comercio con la misma clave -> 409 idempotency_key_reused", async () => {
  const w = newWorld();
  w.merchants.set(TENANT, merchantCred());
  w.merchants.set(OTHER, merchantCred());
  const { client } = await addClient(w, { kind: "internal" });
  const first = await create(w, String(client.id), { merchant: TENANT, idem: "idem-m" });
  const again = await create(w, String(client.id), { merchant: TENANT, idem: "idem-m" });
  assertEquals(again.replayed, true);
  assertEquals(again.link.id, first.link.id);
  assertEquals(wompiPosts(w).length, 1);
  for (const m of [OTHER, null]) {
    const e = await rejection(create(w, String(client.id), { merchant: m, idem: "idem-m" }));
    assertEquals([e.status, e.code], [409, "idempotency_key_reused"]);
  }
  assertEquals(wompiPosts(w).length, 1);
});

async function merchantLink(w: W) {
  w.merchants.set(TENANT, merchantCred());
  const { client } = await addClient(w, { kind: "internal" });
  w.callbacks.set("https://hooks.example.com/pay", () => new Response("ok", { status: 200 }));
  const r = await create(w, String(client.id), { merchant: TENANT });
  return { client, link: r.link, wompiLinkId: String(w.links.find((l) => l.id === r.link.id)!.wompi_link_id) };
}
const post = (h: (r: Request) => Promise<Response>, payload: unknown) => h(req("POST", "/v1/events/wompi", { body: payload }));

Deno.test("evento de link de comercio: se verifica con SU events_key y se confirma con SU private_key; link pagado", async () => {
  const w = newWorld();
  const { link, wompiLinkId } = await merchantLink(w);
  const h = handler(w);
  const r = await post(h, await wompiEvent({ linkId: wompiLinkId, txId: "tx-M1", eventsKey: MERCHANT_KEYS.eventsKey }));
  assertEquals(r.status, 200);
  assertEquals((await r.json()).classification, "processed");
  const verifyCall = w.fetchCalls.find((c) => c.url.includes("/transactions/tx-M1"))!;
  assertEquals(auth(verifyCall), `Bearer ${MERCHANT_KEYS.privateKey}`);
  assertEquals(w.links.find((l) => l.id === link.id)!.status, "paid");
  assertEquals(w.deliveries.length, 1, "aviso firmado al consumidor del cliente interno");
});

Deno.test("evento de link de comercio firmado con la events_key de la PLATAFORMA u OTRO comercio -> 401, link intacto, sin consultar a Wompi", async () => {
  const w = newWorld();
  const { link, wompiLinkId } = await merchantLink(w);
  const h = handler(w);
  for (const key of [SECRETS.eventsKey, "test_events_OTHERMERCHANT000"]) {
    const r = await post(h, await wompiEvent({ linkId: wompiLinkId, txId: `tx-X-${key.length}`, eventsKey: key }));
    assertEquals(r.status, 401);
    assertEquals((await r.json()).error.code, "invalid_signature");
  }
  assertEquals(w.events.at(-1)!.classification, "invalid_signature");
  assertEquals(w.links.find((l) => l.id === link.id)!.status, "pending");
  assertEquals(w.verify.calls.length, 0);
  assertEquals(w.deliveries.length, 0);
});

Deno.test("evento de link de PLATAFORMA firmado con la events_key de un comercio -> 401 (y con la de plataforma sigue procesando)", async () => {
  const w = newWorld();
  const c = await addClient(w);
  w.callbacks.set("https://hooks.example.com/pay", () => new Response("ok", { status: 200 }));
  const h = handler(w);
  const A = await createOwnLink(w, h, c.apiKey, { external_reference: "plat" });
  const bad = await post(h, await wompiEvent({ linkId: A.wompiLinkId, txId: "tx-P1", eventsKey: MERCHANT_KEYS.eventsKey }));
  assertEquals(bad.status, 401);
  const good = await post(h, await wompiEvent({ linkId: A.wompiLinkId, txId: "tx-P2" }));
  assertEquals((await good.json()).classification, "processed");
  assertEquals(auth(w.fetchCalls.find((x) => x.url.includes("/transactions/tx-P2"))!), `Bearer ${SECRETS.privateKey}`);
});

Deno.test("credencial del comercio no resoluble al recibir el evento: 401 invalid_signature indistinguible (nunca 503), link intacto, log critical", async () => {
  const w = newWorld();
  const { link, wompiLinkId } = await merchantLink(w);
  w.merchants.delete(TENANT);
  const h = handler(w);
  const ev = await wompiEvent({ linkId: wompiLinkId, txId: "tx-GONE", eventsKey: MERCHANT_KEYS.eventsKey });
  const cap = await captureLogs(() => post(h, ev));
  assertEquals(cap.result.status, 401);
  assertEquals((await cap.result.json()).error.code, "invalid_signature");
  assert(cap.logs.includes("merchant_credential_unavailable") && cap.logs.includes('"level":"critical"'));
  assertEquals(w.links.find((l) => l.id === link.id)!.status, "pending");
  assertEquals(w.verify.calls.length, 0);
});

Deno.test("replay: el mismo evento firmado de un comercio reentregado a otro link no paga el segundo", async () => {
  const w = newWorld();
  const { link, wompiLinkId } = await merchantLink(w);
  const second = await create(w, String(w.clients[0].id), { merchant: TENANT, req: { external_reference: "otro" } });
  const secondWompi = String(w.links.find((l) => l.id === second.link.id)!.wompi_link_id);
  const h = handler(w);
  const ev = await wompiEvent({ linkId: wompiLinkId, txId: "tx-RP", eventsKey: MERCHANT_KEYS.eventsKey });
  assertEquals((await (await post(h, ev)).json()).classification, "processed");
  const forged = JSON.parse(JSON.stringify(ev));
  forged.data.transaction.payment_link_id = secondWompi;
  const r = await post(h, forged);
  assertEquals((await r.json()).classification, "verification_mismatch");
  assertEquals(w.links.find((l) => l.id === second.link.id)!.status, "pending");
  assertEquals(w.links.find((l) => l.id === link.id)!.status, "paid");
});

Deno.test("admin: POST /admin/clients acepta kind (default external); kind invalido -> 422; la lista lo proyecta", async () => {
  const w = newWorld();
  const h = handler(w);
  const H = { authorization: `Bearer ${SECRETS.adminJwt}` };
  let r = await h(req("POST", "/admin/clients", { headers: H, body: { name: "Leadly interno", kind: "internal" } }));
  assertEquals(r.status, 201);
  assertEquals((await r.json()).client.kind, "internal");
  r = await h(req("POST", "/admin/clients", { headers: H, body: { name: "Lexy Legal" } }));
  assertEquals((await r.json()).client.kind, "external");
  const call = w.rpcCalls.filter((c) => c.fn === "payments_admin_create_client");
  assertEquals(call.map((c) => c.args.p_kind), ["internal", "external"]);
  r = await h(req("POST", "/admin/clients", { headers: H, body: { name: "Malo", kind: "root" } }));
  assertEquals(r.status, 422);
  r = await h(req("GET", "/admin/clients", { headers: H }));
  assertEquals((await r.json()).items.map((c: { kind: string }) => c.kind), ["internal", "external"]);
});

Deno.test("B1: comercio con private_key y SIN events_key -> 409 merchant_credential_unavailable, link en error, 0 llamadas a Wompi", async () => {
  const w = newWorld();
  w.merchants.set(TENANT, { mode: "sandbox", privateKey: MERCHANT_KEYS.privateKey, eventsKey: null });
  const { client } = await addClient(w, { kind: "internal" });
  const e = await rejection(create(w, String(client.id), { merchant: TENANT }));
  assertEquals([e.status, e.code], [409, "merchant_credential_unavailable"]);
  assertEquals(w.links[0].status, "error");
  assertEquals(w.fetchCalls.length, 0);
});

Deno.test("B1: plataforma sin events_key tambien se rechaza al crear (503, link en error, sin Wompi) — el receptor no podria confirmarlo", async () => {
  const w = newWorld();
  w.credential = { mode: "sandbox", privateKey: SECRETS.privateKey, eventsKey: null };
  const { apiKey } = await addClient(w);
  const r = await handler(w)(req("POST", "/v1/payment-links", { key: apiKey, headers: { "idempotency-key": crypto.randomUUID() }, body: validLink() }));
  assertEquals(r.status, 503);
  assertEquals((await r.json()).error.code, "platform_credential_unavailable");
  assertEquals(w.links[0].status, "error");
  assertEquals(w.fetchCalls.length, 0);
});

Deno.test("M1: tenant inactivo/inexistente -> 409 merchant_not_active al CREAR, link en error, sin Wompi", async () => {
  const w = newWorld();
  w.merchants.set(TENANT, merchantCred());
  w.inactiveMerchants.add(TENANT);
  const { client } = await addClient(w, { kind: "internal" });
  const e = await rejection(create(w, String(client.id), { merchant: TENANT }));
  assertEquals([e.status, e.code], [409, "merchant_not_active"]);
  assertEquals(w.links[0].status, "error");
  assertEquals(w.links[0].status_detail, "merchant_not_active");
  assertEquals(w.fetchCalls.length, 0);
});

Deno.test("M1: el receptor NO mira el estado del tenant — un pago de un link ya creado se procesa aunque el tenant se desactive despues", async () => {
  const w = newWorld();
  const { link, wompiLinkId } = await merchantLink(w);
  w.inactiveMerchants.add(TENANT);
  const r = await post(handler(w), await wompiEvent({ linkId: wompiLinkId, txId: "tx-LATE", eventsKey: MERCHANT_KEYS.eventsKey }));
  assertEquals((await r.json()).classification, "processed");
  assertEquals(w.links.find((l) => l.id === link.id)!.status, "paid");
});

Deno.test("M2: PY424 -> 403 merchant_not_allowed; PY423 sigue siendo 409 invalid_state aunque diga 'comercio'", () => {
  const a = mapRpcError("payments_begin_link", { code: "PY424", message: "x" });
  assertEquals([a.status, a.code], [403, "merchant_not_allowed"]);
  const b = mapRpcError("payments_begin_link", { code: "PY423", message: "comercio cualquiera" });
  assertEquals([b.status, b.code], [409, "invalid_state"]);
});

Deno.test("I3: Vault falla para el comercio (events_key o private_key lanzan) -> 401 invalid_signature uniforme con log, nunca 500; plataforma intacta", async () => {
  for (const which of ["events_key", "private_key"]) {
    const w = newWorld();
    const { link, wompiLinkId } = await merchantLink(w);
    const deps = makeDeps(w, {
      getMerchantCredential: async (t) => t === null ? null : {
        mode: "sandbox",
        getSecret: async (n: string) => {
          if (n === which) throw new Error("vault caido");
          return n === "events_key" ? MERCHANT_KEYS.eventsKey : MERCHANT_KEYS.privateKey;
        },
      },
    });
    const { createHandler } = await import("../../functions/_shared/payments-service/router.ts");
    const ev = await wompiEvent({ linkId: wompiLinkId, txId: `tx-V-${which}`, eventsKey: MERCHANT_KEYS.eventsKey });
    const cap = await captureLogs(() => createHandler(deps)(req("POST", "/v1/events/wompi", { body: ev })));
    assertEquals(cap.result.status, 401, which);
    assertEquals((await cap.result.json()).error.code, "invalid_signature");
    assert(cap.logs.includes("merchant_secret_unavailable"));
    assertEquals(w.links.find((l) => l.id === link.id)!.status, "pending");
    assertEquals(w.events.at(-1)!.classification, "invalid_signature");
  }
});
