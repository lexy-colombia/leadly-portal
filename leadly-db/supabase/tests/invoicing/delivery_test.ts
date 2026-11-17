/** S3 (F4): `cac:Delivery` en la factura (Res. DIAN 227/2025 num. 3.2/3.3 +
 * Anexo Técnico 1.9 FAM01-FAM14). Prueba la regla pura, el XML (posición y
 * ausencia), que el CUFE/totales no cambian y el cableado real de
 * `createInvoiceAttempt` (bloqueo) con un cliente falso.
 *
 * No hay validador XSD en el repo ni en el entorno (no existe
 * UBL-Invoice-2.1.xsd en disco): la posición se verifica contra los ejemplos
 * oficiales (Exento de IVA.xml:342-412, Generica.xml:265-334) y la tabla del
 * Anexo, no contra el esquema. */
import { assert, assertEquals, assertNotEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { buildCreditNoteXml, buildInvoiceXml, creditNoteFixtureToInput, invoiceFixtureToInput, parseXml } from "./harness.ts";
import { DELIVERY_MEDELLIN, DELIVERY_OVERRIDE_INVOICES, SYNTHETIC_CREDIT_NOTES, SYNTHETIC_INVOICES } from "./fixtures_synthetic.ts";
import {
  DELIVERY_ADDRESS_MISSING,
  sanitizeAddressLine,
  DELIVERY_DIVIPOLA_MISSING,
  evaluateInvoiceDelivery,
  EMIT_DELIVERY_IN_XML,
  type EvaluateInvoiceDeliveryInput,
} from "../../functions/_shared/invoicing/invoiceDelivery.ts";
import { mapInvoiceDelivery } from "../../functions/_shared/invoicing/invoiceInput.ts";
import { createInvoiceAttempt } from "../../functions/_shared/invoicing/queueInvoiceGeneration.ts";
import { buildOneOffSnapshot, buildShippingSnapshot, REQUIRE_DANE_FOR_DELIVERY } from "../../functions/_shared/orders/fulfillmentAndBilling.ts";

const MEDELLIN = { cityName: "Medellín", departmentName: "Antioquia" };
const SNAP = {
  address_id: "a1", line1: "Carrera 43A # 1-50", line2: "Torre 2 Apto 301", city: "Medellín", state_province: "Antioquia",
  country: "CO", city_code: "05001", state_code: "05", recipient_name: "X", frozen_at: "2026-11-12T00:00:00Z",
};

function evalInput(over: Partial<EvaluateInvoiceDeliveryInput> = {}): EvaluateInvoiceDeliveryInput {
  return { fulfillmentMethod: "delivery", shippingSnapshot: SNAP, buyerDocumentTypeCode: "13", divipola: MEDELLIN, requireDane: false, emit: true, ...over };
}

Deno.test("el interruptor EMIT_DELIVERY_IN_XML está APAGADO (decisión del usuario: la factura no lleva cac:Delivery)", () => {
  assertEquals(EMIT_DELIVERY_IN_XML, false);
});

Deno.test("la constante REQUIRE_DANE_FOR_DELIVERY sigue apagada (decisión S2)", () => {
  assertEquals(REQUIRE_DANE_FOR_DELIVERY, false);
});

Deno.test("(a) entrega a comprador con cédula y DIVIPOLA completo -> se emite", () => {
  const r = evaluateInvoiceDelivery(evalInput());
  assertEquals(r.missing, []);
  assertEquals(r.delivery, {
    line1: "Carrera 43A # 1-50, Torre 2 Apto 301", city: "Medellín", state_province: "Antioquia", country: "CO", city_code: "05001", state_code: "05",
  });
});

Deno.test("(b) entrega a comprador con NIT: se emite si está completo; nunca bloquea", () => {
  const ok = evaluateInvoiceDelivery(evalInput({ buyerDocumentTypeCode: "31", requireDane: true }));
  assertEquals(ok.missing, []);
  assert(ok.delivery);
  // Incompleto + NIT + regla encendida: opcional, no bloquea y no emite a medias.
  const incompleto = evaluateInvoiceDelivery(evalInput({ buyerDocumentTypeCode: "31", requireDane: true, divipola: null, shippingSnapshot: { ...SNAP, city_code: null } }));
  assertEquals(incompleto, { delivery: null, missing: [] });
});

Deno.test("(c) pickup / on_site / sin método: sin Delivery y sin bloqueo", () => {
  for (const method of ["on_site", "pickup", null, undefined]) {
    assertEquals(evaluateInvoiceDelivery(evalInput({ fulfillmentMethod: method, requireDane: true })), { delivery: null, missing: [] });
  }
});

Deno.test("(d) entrega sin DIVIPOLA: regla apagada -> sin Delivery ni bloqueo; encendida y no-NIT -> faltante exacto", () => {
  const sinCodigos = { ...SNAP, city_code: null, state_code: null };
  assertEquals(evaluateInvoiceDelivery(evalInput({ shippingSnapshot: sinCodigos, divipola: null, requireDane: false })), { delivery: null, missing: [] });
  const bloqueada = evaluateInvoiceDelivery(evalInput({ shippingSnapshot: sinCodigos, divipola: null, requireDane: true }));
  assertEquals(bloqueada, { delivery: null, missing: ["departamento y municipio de entrega"] });
  assertEquals(DELIVERY_DIVIPOLA_MISSING, "departamento y municipio de entrega");
  // Códigos presentes pero que NO están en el catálogo (divipola null) o no son compatibles: igual.
  assertEquals(evaluateInvoiceDelivery(evalInput({ divipola: null, requireDane: true })).missing, [DELIVERY_DIVIPOLA_MISSING]);
  // Solo el municipio sin departamento.
  assertEquals(evaluateInvoiceDelivery(evalInput({ shippingSnapshot: { ...SNAP, state_code: null }, divipola: null, requireDane: true })).missing, [DELIVERY_DIVIPOLA_MISSING]);
  // Consumidor Final (documento 13 / 222222222222) también es no-NIT (num. 3.3).
  assertEquals(evaluateInvoiceDelivery(evalInput({ buyerDocumentTypeCode: "13", divipola: null, requireDane: true })).missing, [DELIVERY_DIVIPOLA_MISSING]);
  // Sin snapshot o con línea de relleno: falta la dirección misma.
  assertEquals(evaluateInvoiceDelivery(evalInput({ shippingSnapshot: null, requireDane: true })), { delivery: null, missing: [DELIVERY_ADDRESS_MISSING] });
  assertEquals(evaluateInvoiceDelivery(evalInput({ shippingSnapshot: { ...SNAP, line1: "Dirección pendiente" }, requireDane: true })).missing, [DELIVERY_ADDRESS_MISSING]);
  assertEquals(evaluateInvoiceDelivery(evalInput({ shippingSnapshot: { ...SNAP, line1: "Avenida Colina 5" }, requireDane: true })).missing, [], "'Colina' no es relleno ('na' dentro de una palabra)");
});

Deno.test("(e) exterior: se omite aunque esté completo y nunca bloquea", () => {
  const us = { ...SNAP, country: "US", city_code: null, state_code: null, city: "Miami" };
  assertEquals(evaluateInvoiceDelivery(evalInput({ shippingSnapshot: us, divipola: null, requireDane: true })), { delivery: null, missing: [] });
  assertEquals(evaluateInvoiceDelivery(evalInput({ shippingSnapshot: { ...us, line1: "1 Main St" }, divipola: null, requireDane: false })), { delivery: null, missing: [] });
  // Colombia escrito como nombre cuenta; país vacío/ausente NO (FAM12 exige país, no se asume CO).
  assert(evaluateInvoiceDelivery(evalInput({ shippingSnapshot: { ...SNAP, country: "Colombia" } })).delivery);
  for (const country of [null, "", "  "]) {
    assertEquals(evaluateInvoiceDelivery(evalInput({ shippingSnapshot: { ...SNAP, country } })), { delivery: null, missing: [] });
    assertEquals(evaluateInvoiceDelivery(evalInput({ shippingSnapshot: { ...SNAP, country }, requireDane: true })).missing, [DELIVERY_DIVIPOLA_MISSING]);
  }
});

Deno.test("línea muy larga se recorta a 300 (FAM10) y la línea 2 se anexa", () => {
  const r = evaluateInvoiceDelivery(evalInput({ shippingSnapshot: { ...SNAP, line1: "x".repeat(400), line2: null } }));
  assertEquals(r.delivery!.line1.length, 300);
});

function childNames(xml: string): string[] {
  const root = parseXml(xml).documentElement;
  const out: string[] = [];
  for (let n = root.firstChild; n; n = n.nextSibling) if (n.nodeType === 1) out.push((n as Element).nodeName);
  return out;
}

const fx = (label: string) => [...SYNTHETIC_INVOICES, ...DELIVERY_OVERRIDE_INVOICES].find((f) => f.label === label)!;

Deno.test("orden de elementos: AccountingCustomerParty -> Delivery -> PaymentMeans (cédula y NIT)", async () => {
  for (const label of ["entrega-cedula-divipola", "entrega-nit-divipola"]) {
    const { xml } = await buildInvoiceXml(invoiceFixtureToInput(fx(label), undefined, undefined, true).input);
    const names = childNames(xml);
    const i = names.indexOf("cac:AccountingCustomerParty");
    assertEquals(names[i + 1], "cac:Delivery", label);
    assertEquals(names[i + 2], "cac:PaymentMeans", label);
    assertEquals(names.filter((n) => n === "cac:Delivery").length, 1);
    // Hijos de DeliveryAddress en el orden del Anexo/ejemplos oficiales.
    const addr = parseXml(xml).getElementsByTagName("cac:DeliveryAddress")[0];
    const kids: string[] = [];
    for (let n = addr.firstChild; n; n = n.nextSibling) if (n.nodeType === 1) kids.push((n as Element).nodeName);
    assertEquals(kids, ["cbc:ID", "cbc:CityName", "cbc:CountrySubentity", "cbc:CountrySubentityCode", "cac:AddressLine", "cac:Country"]);
    assertEquals(addr.getElementsByTagName("cbc:ID")[0].textContent, "05001");
    assertEquals(addr.getElementsByTagName("cbc:CountrySubentityCode")[0].textContent, "05");
    assertEquals(addr.getElementsByTagName("cbc:Line")[0].textContent, "Carrera 43A # 1-50, Torre 2 Apto 301");
    assertEquals(addr.getElementsByTagName("cbc:IdentificationCode")[0].textContent, "CO");
    assertEquals(addr.getElementsByTagName("cbc:Name")[0].getAttribute("languageID"), "es");
    assertEquals(addr.getElementsByTagName("cbc:PostalZone").length, 0);
  }
});

Deno.test("sin delivery (pickup/on_site/exterior/incompleto): el XML NO trae cac:Delivery", async () => {
  for (const label of ["inc8-consumidor-final", "perfil-extranjero", "perfil-empresa-nit"]) {
    const { xml } = await buildInvoiceXml(invoiceFixtureToInput(fx(label), undefined, undefined, true).input);
    assertEquals(parseXml(xml).getElementsByTagName("cac:Delivery").length, 0, label);
  }
});

Deno.test("el CUFE, los totales y el resto del XML NO cambian por tener Delivery", async () => {
  const con = fx("entrega-cedula-divipola");
  const sin = { ...con, buyer: { ...con.buyer, delivery: null } };
  const a = await buildInvoiceXml(invoiceFixtureToInput(con, undefined, undefined, true).input);
  const b = await buildInvoiceXml(invoiceFixtureToInput(sin, undefined, undefined, true).input);
  assertEquals(a.cufe, b.cufe, "el CUFE no debe depender de cac:Delivery");
  // Quitando el bloque, los bytes son idénticos (el cambio es solo estructural).
  const bloque = a.xml.slice(a.xml.indexOf("\n   <cac:Delivery>"), a.xml.indexOf("</cac:Delivery>") + "</cac:Delivery>".length);
  assertNotEquals(bloque, "");
  assertEquals(a.xml.replace(bloque, ""), b.xml);
  // Y el UUID del XML coincide con el CUFE.
  assertEquals(parseXml(a.xml).getElementsByTagName("cbc:UUID")[0].textContent, a.cufe);
});

Deno.test("escape XML en la dirección de entrega", async () => {
  const con = fx("entrega-cedula-divipola");
  const f = { ...con, buyer: { ...con.buyer, delivery: { ...DELIVERY_MEDELLIN, line1: "Calle 1 & <2> \"x\"" } } };
  const { xml } = await buildInvoiceXml(invoiceFixtureToInput(f, undefined, undefined, true).input);
  const line = parseXml(xml).getElementsByTagName("cac:DeliveryAddress")[0].getElementsByTagName("cbc:Line")[0].textContent;
  assertEquals(line, 'Calle 1 & <2> "x"');
  assert(xml.includes("Calle 1 &amp; &lt;2&gt; &quot;x&quot;"));
});

Deno.test("mapInvoiceDelivery: defensa en profundidad, nunca emite a medias", () => {
  const ok = { ...DELIVERY_MEDELLIN };
  assert(mapInvoiceDelivery({ delivery: ok }, true));
  assertEquals(mapInvoiceDelivery({}, true), null);
  assertEquals(mapInvoiceDelivery({ delivery: null }, true), null);
  assertEquals(mapInvoiceDelivery({ delivery: { ...ok, city_code: "" } }, true), null);
  assertEquals(mapInvoiceDelivery({ delivery: { ...ok, state_code: "" } }, true), null);
  assertEquals(mapInvoiceDelivery({ delivery: { ...ok, line1: "  " } }, true), null);
  assertEquals(mapInvoiceDelivery({ delivery: { ...ok, state_code: "11" } }, true), null, "municipio 05001 no pertenece al departamento 11");
  assertEquals(mapInvoiceDelivery({ delivery: { ...ok, city_code: "Medellín" } }, true), null);
  // deno-lint-ignore no-explicit-any
  assertEquals(mapInvoiceDelivery({ delivery: { ...ok, country: "US" as any } }, true), null);
});

Deno.test("nota crédito: no lleva cac:Delivery (CAM01 0..1; no se cambia)", async () => {
  for (const nc of SYNTHETIC_CREDIT_NOTES) {
    const { xml } = await buildCreditNoteXml(creditNoteFixtureToInput(nc).input);
    assertEquals(parseXml(xml).getElementsByTagName("cac:Delivery").length, 0, nc.label);
  }
});

// ---- cableado real: createInvoiceAttempt -> buildOrderSnapshot (cliente falso) ----

// deno-lint-ignore no-explicit-any
type Any = any;
function fakeClient(tables: Record<string, { one?: unknown; many?: unknown[] }>, inserted: { table: string; row: Any }[]): Any {
  return {
    from(table: string) {
      const cfg = tables[table] ?? {};
      // deno-lint-ignore no-explicit-any
      const chain: any = {};
      for (const m of ["select", "eq", "is", "in", "order", "limit", "not", "delete", "update"]) chain[m] = () => chain;
      chain.insert = (row: Any) => {
        inserted.push({ table, row });
        return chain;
      };
      chain.maybeSingle = () => Promise.resolve({ data: cfg.one ?? null, error: null });
      chain.single = () => Promise.resolve({ data: cfg.one ?? null, error: null });
      chain.then = (res: Any, rej: Any) => Promise.resolve({ data: cfg.many ?? [], error: null }).then(res, rej);
      return chain;
    },
  };
}

const PROFILE_CEDULA = {
  id: "p1", tenant_id: "t", client_id: "c1", label: "Principal", is_default: true,
  document_type_code: "13", document_number: "79123456", legal_name: "MARIA PEREZ", email: "maria@example.invalid", phone: null,
  organization_type: "2", tax_level_code: "R-99-PN", tax_scheme_code: "ZZ", applies_withholding: false,
  // Sin domicilio fiscal: no se consulta el catálogo para el comprador.
  address_line1: null, address_line2: null, country: null, state_code: null, city_code: null, state_province: null, city: null,
};

function world(over: { profile?: Record<string, unknown>; order?: Record<string, unknown>; cities?: unknown; departments?: unknown } = {}) {
  const inserted: { table: string; row: Any }[] = [];
  const client = fakeClient({
    integration_credentials: { one: { id: "cred" } },
    sales_orders: {
      one: { subtotal: 100, tax_total: 0, total: 100, currency: "COP", contact_id: "c1", billing_profile_id: "p1", fulfillment_method: "delivery", shipping_snapshot: SNAP, ...over.order },
    },
    clients: { one: { id: "c1", full_name: "Maria", document_number: "x", dian_document_type_code: "13", is_walk_in: false } },
    client_billing_profiles: { one: { ...PROFILE_CEDULA, ...over.profile } },
    cities: { one: "cities" in over ? over.cities : { name: "Medellín" } },
    departments: { one: "departments" in over ? over.departments : { name: "Antioquia" } },
    tenants: { one: { legal_name: "T", document_type: "31", document_number: "900", city_code: null } },
    tenant_dian_profile: { one: null },
    sales_invoices: { one: { id: "inv1" }, many: [] },
    sales_order_items: { many: [] },
  }, inserted);
  return { client, inserted };
}

async function attempt(w: ReturnType<typeof world>, requireDeliveryDivipola?: boolean) {
  const r = await createInvoiceAttempt(w.client, "t", "o1", 1, { requireDeliveryDivipola, emitDelivery: true });
  const inv = w.inserted.find((i) => i.table === "sales_invoices")!.row;
  return { r, buyer: inv.buyer_snapshot as Any };
}

Deno.test("cableado: pedido de entrega con DIVIPOLA válido -> buyer_snapshot.delivery completo, pending", async () => {
  const { r, buyer } = await attempt(world(), true);
  assertEquals(r.status, "pending");
  assertEquals(buyer.delivery.city_code, "05001");
  assertEquals(buyer.delivery.city, "Medellín");
  assertEquals(buyer.delivery.line1, "Carrera 43A # 1-50, Torre 2 Apto 301");
  // El comprador del snapshot no cambió por traer delivery.
  assertEquals(buyer.document_number, "79123456");
});

Deno.test("cableado: la fila de pedido sin shipping_snapshot ni 'delivery' no rompe (pickup/on_site)", async () => {
  for (const method of ["on_site", "pickup"]) {
    const { r, buyer } = await attempt(world({ order: { fulfillment_method: method, shipping_snapshot: null } }), true);
    assertEquals(r.status, "pending");
    assertEquals(buyer.delivery, null);
  }
});

Deno.test("cableado: entrega sin DIVIPOLA; regla apagada -> pending sin delivery (nunca bloquea)", async () => {
  const w = world({ order: { shipping_snapshot: { ...SNAP, city_code: null, state_code: null } } });
  const { r, buyer } = await attempt(w, false);
  assertEquals(r.status, "pending");
  assertEquals(buyer.delivery, null);
  // Sin pasar la opción: usa la constante (apagada).
  const w2 = world({ order: { shipping_snapshot: { ...SNAP, city_code: null, state_code: null } } });
  assertEquals((await attempt(w2)).r.status, "pending");
});

Deno.test("cableado: entrega sin DIVIPOLA + regla encendida + no-NIT -> blocked con el faltante exacto", async () => {
  const w = world({ order: { shipping_snapshot: { ...SNAP, city_code: null, state_code: null } } });
  const { r, buyer } = await attempt(w, true);
  assertEquals(r.status, "blocked_missing_buyer_data");
  assertEquals(r.statusDetail, "Falta: departamento y municipio de entrega");
  assertEquals(buyer.delivery, null);
  // Códigos que no existen en el catálogo: igual.
  const w2 = world({ cities: null });
  assertEquals((await attempt(w2, true)).r.statusDetail, "Falta: departamento y municipio de entrega");
});

Deno.test("cableado: regla encendida pero comprador con NIT -> opcional, no bloquea", async () => {
  const w = world({
    profile: { document_type_code: "31", document_number: "900123456-8", legal_name: "EMPRESA SAS", organization_type: "1", tax_level_code: "O-13", tax_scheme_code: "01" },
    order: { shipping_snapshot: { ...SNAP, city_code: null, state_code: null } },
  });
  const { r, buyer } = await attempt(w, true);
  assertEquals(r.status, "pending");
  assertEquals(buyer.delivery, null);
});

Deno.test("cableado: exterior con regla encendida -> sin delivery y sin bloqueo", async () => {
  const w = world({ order: { shipping_snapshot: { ...SNAP, country: "US", city_code: null, state_code: null } } });
  const { r, buyer } = await attempt(w, true);
  assertEquals(r.status, "pending");
  assertEquals(buyer.delivery, null);
});

Deno.test("cableado: perfil con faltantes propios + regla encendida -> solo los faltantes del comprador (sin ruido de entrega)", async () => {
  const w = world({ profile: { legal_name: null, document_type_code: null, document_number: null }, order: { shipping_snapshot: { ...SNAP, city_code: null, state_code: null } } });
  const { r } = await attempt(w, true);
  assertEquals(r.status, "blocked_missing_buyer_data");
  assert(!r.statusDetail!.includes("entrega"));
});

// ---- Ronda 2: saneo de la línea (XML 1.0) ----

Deno.test("sanitizeAddressLine: controles XML inválidos fuera, saltos/tabs a un espacio, sin partir emoji", () => {
  assertEquals(sanitizeAddressLine("Calle\u0001 1\u0000\u0008\u000B\u000C\u000E\u001F\uFFFE\uFFFF"), "Calle 1");
  assertEquals(sanitizeAddressLine("Calle 1\n\n  Apto\t5\r\nTorre 2\u2028x"), "Calle 1 Apto 5 Torre 2 x");
  // Sustitutos sueltos (XML inválido) se eliminan; el par válido se conserva.
  assertEquals(sanitizeAddressLine("a\uD83Db\uDE00c😀"), "abc😀");
  // Límite por code points: 299 letras + emoji = 300 -> el emoji entra completo; 300 + emoji -> se recorta antes del emoji, sin mitad de par.
  const borde = sanitizeAddressLine("x".repeat(299) + "😀");
  assertEquals(Array.from(borde).length, 300);
  assertEquals(borde.endsWith("😀"), true);
  const pasado = sanitizeAddressLine("x".repeat(300) + "😀");
  assertEquals(Array.from(pasado).length, 300);
  assertEquals(pasado.includes("😀"), false);
  assert(!/[\uD800-\uDFFF]/.test(sanitizeAddressLine("x".repeat(299) + "😀😀").replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "")), "sin sustitutos sueltos");
  // Solo controles -> vacío (la línea se trata como ausente).
  assertEquals(sanitizeAddressLine("\u0001\u0002 \n"), "");
});

Deno.test("línea con caracteres peligrosos: el XML generado sigue siendo parseable y bien escapado", async () => {
  const sucia = "Calle 1\u0001 & <2>\n\"x\" 'y'\tApto\uFFFE" + "😀".repeat(5);
  const r = evaluateInvoiceDelivery(evalInput({ shippingSnapshot: { ...SNAP, line1: sucia, line2: null } }));
  assertEquals(r.delivery!.line1, "Calle 1 & <2> \"x\" 'y' Apto" + "😀".repeat(5));
  const con = fx("entrega-cedula-divipola");
  const f = { ...con, buyer: { ...con.buyer, delivery: { ...DELIVERY_MEDELLIN, line1: sucia } } };
  const { xml } = await buildInvoiceXml(invoiceFixtureToInput(f, undefined, undefined, true).input);
  assert(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/.test(xml));
  const line = parseXml(xml).getElementsByTagName("cac:DeliveryAddress")[0].getElementsByTagName("cbc:Line")[0].textContent;
  assertEquals(line, "Calle 1 & <2> \"x\" 'y' Apto" + "😀".repeat(5));
  // Línea 1 muy larga con emoji al borde, vía snapshot completo.
  const larga = evaluateInvoiceDelivery(evalInput({ shippingSnapshot: { ...SNAP, line1: "y".repeat(299), line2: "😀😀" } }));
  assertEquals(Array.from(larga.delivery!.line1).length, 300);
  const f2 = { ...con, buyer: { ...con.buyer, delivery: larga.delivery } };
  const x2 = (await buildInvoiceXml(invoiceFixtureToInput(f2, undefined, undefined, true).input)).xml;
  assertEquals(parseXml(x2).getElementsByTagName("cac:DeliveryAddress")[0].getElementsByTagName("cbc:Line")[0].textContent, larga.delivery!.line1);
  // Una línea que queda vacía tras el saneo se trata como ausente.
  assertEquals(evaluateInvoiceDelivery(evalInput({ shippingSnapshot: { ...SNAP, line1: "\u0001\n" }, requireDane: true })).missing, [DELIVERY_ADDRESS_MISSING]);
});

// ---- Ronda 2: contrato del shipping_snapshot entre SQL (S1/S2) y esta regla ----

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const KEYS = ["line1", "line2", "country", "city_code", "state_code"];

/** Claves de cada `jsonb_build_object(...)` que contiene 'frozen_at' en un SQL. */
function snapshotBlocks(sql: string): string[][] {
  const out: string[][] = [];
  let from = 0;
  for (;;) {
    const i = sql.indexOf("jsonb_build_object(", from);
    if (i < 0) break;
    let depth = 0;
    let j = i + "jsonb_build_object".length;
    for (; j < sql.length; j++) {
      if (sql[j] === "(") depth++;
      else if (sql[j] === ")" && --depth === 0) break;
    }
    const body = sql.slice(i, j + 1);
    if (body.includes("'frozen_at'")) out.push([...body.matchAll(/'([a-z0-9_]+)'\s*,/g)].map((m) => m[1]));
    from = j;
  }
  return out;
}

Deno.test("contrato: todo productor SQL/TS del shipping_snapshot usa las 5 claves que lee la regla de Delivery", async () => {
  const guard = snapshotBlocks(await Deno.readTextFile(new URL("20261112123000_order_fulfillment_functions.sql", MIGRATIONS)));
  const correct = snapshotBlocks(await Deno.readTextFile(new URL("20261112128000_correct_order_shipping.sql", MIGRATIONS)));
  // guard (dirección guardada) + correct_order_shipping (dirección guardada y destino puntual). El otro bloque con
  // 'frozen_at' del archivo 123000 es del snapshot de factura (buyer), que no es un destino: se filtra por 'line1'+'one_off'|'address_id'.
  const destinos = [...guard, ...correct].filter((k) => k.includes("address_id") && k.includes("line1"));
  assert(destinos.length >= 3, `se esperaban >=3 productores SQL de destino, hay ${destinos.length}`);
  for (const keys of destinos) for (const k of KEYS) assert(keys.includes(k), `falta la clave '${k}' en un productor SQL: ${keys.join(",")}`);

  // Productores TS (los mismos que usa calculate-order): mismas claves.
  const addr = { id: "a", tenant_id: "t", contact_id: "c", line1: "Cra 1 # 2-3", line2: "Apto 4", country: "CO", city_code: "05001", state_code: "05" };
  const ts = [buildShippingSnapshot(addr), buildOneOffSnapshot({ line1: "Cra 1 # 2-3", line2: "Apto 4", country: "CO", city_code: "05001", state_code: "05" })];
  for (const snap of ts) {
    for (const k of KEYS) assert(k in snap, `falta '${k}' en el snapshot TS`);
    // Y la regla de Delivery lo consume tal cual lo produce el servidor.
    const r = evaluateInvoiceDelivery(evalInput({ shippingSnapshot: snap as Record<string, unknown> }));
    assertEquals(r.delivery?.city_code, "05001");
    assertEquals(r.delivery?.line1, "Cra 1 # 2-3, Apto 4");
  }
});

// ---- Ronda 4: Delivery apagado por defecto ----

const noDelivery = (xml: string) => {
  assert(!xml.includes("cac:Delivery"), "el XML no debe contener cac:Delivery");
  assert(!xml.includes("cac:DeliveryAddress"), "el XML no debe contener cac:DeliveryAddress");
  assertEquals(parseXml(xml).getElementsByTagName("cac:Delivery").length, 0);
};

Deno.test("snapshots de los fixtures de entrega (con override explícito)", async () => {
  const UPDATE = Deno.env.get("S0_UPDATE_SNAPSHOTS") === "1";
  for (const f of DELIVERY_OVERRIDE_INVOICES) {
    const { xml } = await buildInvoiceXml(invoiceFixtureToInput(f, undefined, undefined, true).input);
    const file = new URL(`./snapshots/delivery-override__${f.label}.xml`, import.meta.url);
    if (UPDATE) await Deno.writeTextFile(file, xml);
    else assertEquals(xml, await Deno.readTextFile(file), f.label);
    assertStringIncludes(xml, "<cac:Delivery>");
  }
});

Deno.test("POR DEFECTO ningún fixture produce cac:Delivery (cédula, NIT, on_site, exterior, delivery ya guardado)", async () => {
  const todos = [...SYNTHETIC_INVOICES, ...DELIVERY_OVERRIDE_INVOICES];
  for (const f of todos) {
    const { xml } = await buildInvoiceXml(invoiceFixtureToInput(f).input);
    noDelivery(xml);
  }
  // Un buyer_snapshot con delivery YA guardado (de una ronda anterior) también se ignora.
  const guardado = { ...fx("perfil-persona-natural"), buyer: { ...fx("perfil-persona-natural").buyer, delivery: DELIVERY_MEDELLIN } };
  assert(guardado.buyer.delivery);
  assertEquals(mapInvoiceDelivery(guardado.buyer), null);
  noDelivery((await buildInvoiceXml(invoiceFixtureToInput(guardado).input)).xml);
  // Mismo fixture con override: ahí sí aparece (prueba de que el interruptor es lo que lo apaga).
  assertStringIncludes((await buildInvoiceXml(invoiceFixtureToInput(guardado, undefined, undefined, true).input)).xml, "<cac:Delivery>");
});

Deno.test("POR DEFECTO evaluateInvoiceDelivery omite siempre y nunca agrega faltantes (ni con REQUIRE_DANE encendida)", () => {
  const casos: Partial<EvaluateInvoiceDeliveryInput>[] = [
    {}, // cédula con DIVIPOLA completo
    { buyerDocumentTypeCode: "31" },
    { fulfillmentMethod: "on_site" },
    { shippingSnapshot: { ...SNAP, country: "US" } },
    { shippingSnapshot: { ...SNAP, city_code: null }, divipola: null },
    { shippingSnapshot: null, divipola: null },
  ];
  for (const c of casos) {
    for (const requireDane of [false, true]) {
      const { emit: _omit, ...base } = evalInput();
      assertEquals(evaluateInvoiceDelivery({ ...base, ...c, requireDane }), { delivery: null, missing: [] });
    }
  }
});

Deno.test("POR DEFECTO createInvoiceAttempt no arma buyer_snapshot.delivery ni bloquea por entrega (ni con la regla encendida)", async () => {
  const sinDivipola = { ...SNAP, city_code: null, state_code: null };
  for (const order of [{}, { shipping_snapshot: sinDivipola }, { fulfillment_method: "on_site", shipping_snapshot: null }, { shipping_snapshot: { ...SNAP, country: "US" } }]) {
    const w = world({ order });
    const r = await createInvoiceAttempt(w.client, "t", "o1", 1, { requireDeliveryDivipola: true });
    assertEquals(r.status, "pending");
    assertEquals(r.statusDetail, null);
    const buyer = w.inserted.find((i) => i.table === "sales_invoices")!.row.buyer_snapshot;
    assert(!("delivery" in buyer), "buyer_snapshot no debe tener la clave delivery");
  }
});

Deno.test("ningún snapshot del flujo por defecto contiene cac:Delivery (solo delivery-override__*)", async () => {
  const dir = new URL("./snapshots/", import.meta.url);
  let n = 0;
  for await (const e of Deno.readDir(dir)) {
    if (!e.name.endsWith(".xml")) continue;
    n++;
    const txt = await Deno.readTextFile(new URL(e.name, dir));
    assertEquals(txt.includes("cac:Delivery"), e.name.startsWith("delivery-override__"), e.name);
  }
  assert(n >= 16);
});
