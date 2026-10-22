import { assert, assertEquals, assertFalse, assertRejects } from "jsr:@std/assert@1";
import { sha256Hex, timingSafeEqual, verifyWompiChecksum, wompiExpectedChecksum, canonicalJson, signEnvelope } from "../../functions/_shared/payments-service/hmac.ts";
import { checkCallbackDestination, checkCallbackUrl } from "../../functions/_shared/payments-service/ssrf.ts";
import { generateApiKey, authenticateClient } from "../../functions/_shared/payments-service/apiKeys.ts";
import { redact } from "../../functions/_shared/payments-service/errors.ts";
import { SECRETS, wompiEvent } from "./harness.ts";

Deno.test("timingSafeEqual: iguales, distintos, distinto largo, vacío", async () => {
  assert(await timingSafeEqual("abc", "abc"));
  assertFalse(await timingSafeEqual("abc", "abd"));
  assertFalse(await timingSafeEqual("abc", "abcd"));
  assertFalse(await timingSafeEqual("", "a"));
  assert(await timingSafeEqual("", ""));
});

Deno.test("checksum Wompi propio == SHA-256(valores + timestamp + secreto) calculado aparte (oraculo independiente)", async () => {
  const ev = await wompiEvent({ linkId: "L" });
  assert(await verifyWompiChecksum(ev, SECRETS.eventsKey));
  // oraculo independiente (formula documentada por Wompi), sin pasar por hmac.ts
  const t = ev.data.transaction;
  assertEquals(ev.signature.checksum, await sha256Hex(`${t.id}${t.status}${t.amount_in_cents}${ev.timestamp}${SECRETS.eventsKey}`));
  const bad = await wompiEvent({ linkId: "L", eventsKey: "otra" });
  assertFalse(await verifyWompiChecksum(bad, SECRETS.eventsKey));
  // mayúsculas (la doc de Wompi muestra el checksum en MAYÚSCULAS)
  const up = { ...ev, signature: { ...ev.signature, checksum: ev.signature.checksum.toUpperCase() } };
  assert(await verifyWompiChecksum(up, SECRETS.eventsKey));
  // propiedades: usa las del propio evento (en cualquier orden, con extras)
  const custom = {
    data: { transaction: { id: "z", status: "APPROVED", amount_in_cents: 5, currency: "COP" } }, timestamp: 5,
    signature: { properties: ["transaction.amount_in_cents", "transaction.currency", "transaction.id", "transaction.status"], checksum: "" },
  };
  custom.signature.checksum = (await wompiExpectedChecksum(custom, "k"))!;
  assert(await verifyWompiChecksum(custom, "k"));
  // B2: firma válida pero que NO cubre id, status y monto -> rechazada
  for (const props of [["transaction.id", "transaction.status"], ["transaction.id", "transaction.amount_in_cents"], ["transaction.status", "transaction.amount_in_cents"], ["transaction.id"]]) {
    const weak = { data: custom.data, timestamp: 5, signature: { properties: props, checksum: "" } };
    const concat = props.map((p) => String(p.split(".").reduce((v: any, x) => v?.[x], weak.data))).join("");
    weak.signature.checksum = await sha256Hex(concat + "5" + "k");
    assertFalse(await verifyWompiChecksum(weak, "k"), props.join());
  }
  // faltantes
  assertFalse(await verifyWompiChecksum({ data: {}, signature: {} }, "k"));
  assertFalse(await verifyWompiChecksum({ ...ev, timestamp: undefined }, SECRETS.eventsKey));
});

Deno.test("firma del sobre: t=<unix>,v1=<hmac(t.body)> con vector conocido", async () => {
  const sig = await signEnvelope("secret", '{"a":1}', 1700000000);
  assertEquals(sig, "t=1700000000,v1=" + (await crypto.subtle.importKey("raw", new TextEncoder().encode("secret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
    .then((k) => crypto.subtle.sign("HMAC", k, new TextEncoder().encode('1700000000.{"a":1}')))
    .then((b) => Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join(""))));
});

Deno.test("canonicalJson ordena claves", () => {
  assertEquals(canonicalJson({ b: 1, a: { d: 1, c: 2 } }), canonicalJson({ a: { c: 2, d: 1 }, b: 1 }));
});

Deno.test("anti-SSRF: literales privados y nombres internos", async () => {
  const bad = [
    "https://127.0.0.1/x", "https://127.1.2.3/x", "https://10.0.0.1/x", "https://172.16.0.1/x", "https://172.31.255.255/x",
    "https://192.168.0.1/x", "https://169.254.169.254/latest/meta-data", "https://100.64.0.1/x", "https://0.0.0.0/x",
    "https://2130706433/x", "https://0x7f.0.0.1/x", "https://0177.0.0.1/x", "https://[::1]/x", "https://[::]/x",
    "https://[fe80::1]/x", "https://[fd00:ec2::254]/x", "https://[::ffff:127.0.0.1]/x", "https://[::ffff:10.0.0.1]/x",
    "https://localhost/x", "https://api.localhost/x", "https://metadata.google.internal/x", "https://intranet/x",
    "https://printer.local/x", "https://user:pw@example.com/x", "http://example.com/x", "ftp://example.com/x", "no es url",
    "https://224.0.0.1/x", "https://[ff02::1]/x",
  ];
  for (const u of bad) {
    let threw = false;
    try { checkCallbackUrl(u); } catch { threw = true; }
    assert(threw, `debió rechazar ${u}`);
  }
  for (const u of ["https://hooks.example.com/x", "https://8.8.8.8/x", "https://api.bedly.co:8443/pay?x=1", "https://[2606:4700:4700::1111]/x"]) {
    checkCallbackUrl(u);
  }
});

Deno.test("anti-SSRF con DNS: privada rechaza; resolver que falla = no verificable (documentado)", async () => {
  await assertRejects(() => checkCallbackDestination("https://x.example.com/", async () => ["8.8.8.8", "10.0.0.9"]));
  await assertRejects(() => checkCallbackDestination("https://x.example.com/", async () => ["::1"]));
  await checkCallbackDestination("https://x.example.com/", async () => ["8.8.8.8"]);
  await checkCallbackDestination("https://x.example.com/", async () => { throw new Error("sin permiso"); });
});

Deno.test("API key: formato, hash estable y lookup solo por hash", async () => {
  const k = await generateApiKey("sandbox");
  assert(/^lxy_pay_test_[A-Za-z0-9_-]{8}_[A-Za-z0-9_-]{43}$/.test(k.apiKey));
  const live = await generateApiKey("production");
  assert(live.apiKey.startsWith("lxy_pay_live_"));
  const seen: unknown[] = [];
  const rpc = {
    rpc(fn: string, a: Record<string, unknown> = {}) {
      seen.push({ fn, a });
      return Promise.resolve({ data: { id: "c1", name: "n", status: "active", callback_url: null, signing_secret_name: null }, error: null });
    },
  };
  const c = await authenticateClient(rpc, `Bearer ${k.apiKey}`);
  assertEquals(c.environment, "sandbox");
  assertEquals(JSON.stringify(seen).includes(k.apiKey), false);
  assertEquals((seen[0] as { a: { p_key_hash: string } }).a.p_key_hash, k.keyHash);
});

Deno.test("redact elimina llaves y bearer", () => {
  const t = redact("fallo con Bearer abc.def.ghi y prv_test_ABCDEF123 y test_events_XYZ987 y lxy_pay_test_abcd1234_" + "A".repeat(43));
  assertFalse(/prv_test_ABC|test_events_XYZ|lxy_pay_test_abcd1234_A|abc\.def/.test(t));
});
