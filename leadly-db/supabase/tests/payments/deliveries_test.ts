import { assert, assertEquals } from "jsr:@std/assert@1";
import { addClient, createOwnLink, handler, newWorld, req, wompiEvent, SECRETS } from "./harness.ts";

async function setup(cb: (init: RequestInit) => Promise<Response> | Response, callback = "https://hooks.example.com/pay") {
  const w = newWorld();
  const c = await addClient(w, { callback });
  const h = handler(w);
  const { wompiLinkId } = await createOwnLink(w, h, c.apiKey);
  w.callbacks.set(callback, cb);
  const r = await h(req("POST", "/v1/events/wompi", { body: await wompiEvent({ linkId: wompiLinkId }) }));
  return { w, h, r };
}
const cbCalls = (w: ReturnType<typeof newWorld>) => w.fetchCalls.filter((c) => c.url.startsWith("https://hooks.example.com") || c.url.startsWith("https://10.") || c.url.includes("evil"));

Deno.test("destino 2xx: entregado", async () => {
  const { w } = await setup(() => new Response(null, { status: 204 }));
  assertEquals(w.deliveries[0].status, "delivered");
});

Deno.test("destino 5xx: queda pendiente para reintento y la respuesta a Wompi sigue siendo 200", async () => {
  const { w, r } = await setup(() => new Response("err", { status: 503 }));
  assertEquals(r.status, 200);
  assertEquals(w.deliveries[0].status, "pending");
  assertEquals(w.attempts[0].http_status, 503);
});

Deno.test("destino con timeout: error 'timeout', pendiente", async () => {
  const { w, r } = await setup((init) =>
    new Promise((_, rej) => init.signal!.addEventListener("abort", () => rej(new DOMException("a", "AbortError"))))
  );
  assertEquals(r.status, 200);
  assertEquals(w.attempts[0].error, "timeout");
  assertEquals(w.deliveries[0].status, "pending");
});

Deno.test("redirección 302 NO se sigue: una sola llamada, falla con redirect_not_followed", async () => {
  const { w } = await setup(() => new Response(null, { status: 302, headers: { location: "https://evil.example.com/steal" } }));
  assertEquals(cbCalls(w).length, 1);
  assertEquals(w.attempts[0].error, "redirect_not_followed");
  assertEquals(w.deliveries[0].status, "pending");
  assertEquals(w.fetchCalls.some((c) => c.url.includes("evil")), false);
});

Deno.test("URL privada/loopback/metadata: rechazada sin hacer fetch", async () => {
  for (const url of ["https://10.0.0.5/hook", "https://127.0.0.1/hook", "https://169.254.169.254/latest", "https://[::1]/h", "http://hooks.example.com/pay"]) {
    const w = newWorld();
    const c = await addClient(w, { callback: url });
    const h = handler(w);
    const { wompiLinkId } = await createOwnLink(w, h, c.apiKey);
    await h(req("POST", "/v1/events/wompi", { body: await wompiEvent({ linkId: wompiLinkId }) }));
    assertEquals(w.fetchCalls.filter((x) => x.url === url).length, 0, url);
    assert(String(w.attempts[0].error).startsWith("destination_not_allowed"), url);
  }
});

Deno.test("host que resuelve a IP privada (DNS inyectado) se rechaza", async () => {
  const w = newWorld();
  const c = await addClient(w, { callback: "https://rebind.example.com/hook" });
  const h = handler(w, { resolveDns: async () => ["10.1.2.3"] });
  const { wompiLinkId } = await createOwnLink(w, h, c.apiKey);
  await h(req("POST", "/v1/events/wompi", { body: await wompiEvent({ linkId: wompiLinkId }) }));
  assertEquals(w.fetchCalls.filter((x) => x.url === "https://rebind.example.com/hook").length, 0);
  assertEquals(w.attempts[0].error, "destination_not_allowed:resolves_to_private_address");
});

Deno.test("/internal/dispatch: sin secreto o con secreto incorrecto -> 401; correcto reintenta lo pendiente", async () => {
  const { w, h } = await setup(() => new Response("err", { status: 500 }));
  assertEquals(w.deliveries[0].status, "pending");
  let r = await h(req("POST", "/internal/dispatch"));
  assertEquals(r.status, 401);
  r = await h(req("POST", "/internal/dispatch", { key: "cron-secret-VALUE-1235" }));
  assertEquals(r.status, 401);
  r = await h(req("POST", "/internal/dispatch", { key: "" }));
  assertEquals(r.status, 401);
  w.callbacks.set("https://hooks.example.com/pay", () => new Response("ok", { status: 200 }));
  r = await h(req("POST", "/internal/dispatch", { key: "cron-secret-VALUE-1234" }));
  assertEquals(r.status, 200);
  assertEquals((await r.json()).delivered, 1);
  assertEquals(w.deliveries[0].status, "delivered");
  assertEquals(w.deliveries[0].attempt, 2);
  assert(SECRETS.adminJwt);
});

Deno.test("/internal/redact exige el secreto de cron", async () => {
  const { h } = await setup(() => new Response("ok"));
  assertEquals((await h(req("POST", "/internal/redact"))).status, 401);
  const r = await h(req("POST", "/internal/redact", { key: "cron-secret-VALUE-1234" }));
  assertEquals(r.status, 200);
});

Deno.test("cron sin secreto configurado en la función -> siempre 401", async () => {
  const w = newWorld();
  const h = handler(w, { env: { supabaseUrl: "https://proj.supabase.co", cronSecret: null } });
  assertEquals((await h(req("POST", "/internal/dispatch", { key: "" }))).status, 401);
  assertEquals((await h(req("POST", "/internal/dispatch", { key: "anything" }))).status, 401);
});
