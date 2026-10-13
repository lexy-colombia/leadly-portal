// Ningún secreto debe aparecer en cuerpos de respuesta ni en logs, en un
// recorrido que cubre éxito y errores de todas las áreas.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { addClient, captureLogs, createOwnLink, handler, newWorld, req, SECRETS, validLink, wompiEvent } from "./harness.ts";

Deno.test("ningún secreto aparece en respuestas ni logs (éxito y error)", async () => {
  const w = newWorld();
  const c = await addClient(w, { secret: "lxy_whsec_MARKERSIGNINGSECRET" });
  const h = handler(w);
  const bodies: string[] = [];
  const grab = async (r: Response) => { bodies.push(await r.clone().text()); return r; };

  const { logs } = await captureLogs(async () => {
    const created = await createOwnLink(w, h, c.apiKey);
    bodies.push(JSON.stringify(created.body));
    const link = created.wompiLinkId;
    // éxito, firma mala, ajeno, duplicado, destino roto
    w.callbacks.set("https://hooks.example.com/pay", () => new Response("secret echo " + SECRETS.privateKey, { status: 500 }));
    await grab(await h(req("POST", "/v1/events/wompi", { body: await wompiEvent({ linkId: link }) })));
    await grab(await h(req("POST", "/v1/events/wompi", { body: await wompiEvent({ linkId: link, eventsKey: "x" }) })));
    await grab(await h(req("POST", "/v1/events/wompi", { body: await wompiEvent({ linkId: "ajeno" }) })));
    // errores
    await grab(await h(req("POST", "/v1/payment-links", { key: c.apiKey, headers: { "idempotency-key": "z" }, body: validLink({ client_id: "x" }) })));
    w.wompi.status = 422;
    w.wompi.body = { error: { messages: { sku: ["echo " + SECRETS.privateKey + " " + SECRETS.eventsKey] } } };
    await grab(await h(req("POST", "/v1/payment-links", { key: c.apiKey, headers: { "idempotency-key": "z2" }, body: validLink() })));
    await grab(await h(req("GET", "/admin/clients", { headers: { authorization: `Bearer ${SECRETS.adminJwt}` } })));
    await grab(await h(req("GET", "/admin/clients", { headers: { authorization: "Bearer agent-jwt" } })));
    await grab(await h(req("POST", "/internal/dispatch", { key: "cron-secret-VALUE-1234" })));
    await grab(await h(req("POST", "/internal/dispatch", { key: "mala" })));
    await grab(await h(req("GET", "/admin/readiness", { headers: { authorization: `Bearer ${SECRETS.adminJwt}` } })));
  });

  const everything = bodies.join("\n") + "\n" + logs;
  for (const s of [SECRETS.privateKey, SECRETS.eventsKey, "lxy_whsec_MARKERSIGNINGSECRET", c.apiKey, SECRETS.adminJwt, "cron-secret-VALUE-1234"]) {
    assert(!everything.includes(s), `se filtró un secreto: ${s.slice(0, 12)}...`);
  }
  assert(logs.length > 0, "debe haber logs estructurados");
  // la respuesta del destino (que ecoaba un secreto) nunca se lee ni se loguea
  assertEquals(logs.includes("secret echo"), false);
});
