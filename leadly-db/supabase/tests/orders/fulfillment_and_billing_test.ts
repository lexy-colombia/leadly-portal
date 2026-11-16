import { assertEquals } from "jsr:@std/assert@1";
import {
  billingProfileMismatch, buildOneOffSnapshot, buildShippingSnapshot, describeOrderLinkError, normalizeShippingDestination, evaluateFulfillmentAndBilling, isFulfillmentMethod, type DestinationAddress,
} from "../../functions/_shared/orders/fulfillmentAndBilling.ts";
import { buildFiscalBuyer, type BillingProfileRow } from "../../functions/_shared/invoicing/clientBillingProfile.ts";
import { isPlaceholderAddressText } from "../../functions/_shared/orders/confirmSalesOrder.ts";

const T = "tenant-1", C = "client-1";
const addr = (o: Partial<DestinationAddress> = {}): DestinationAddress => ({
  id: "a1", tenant_id: T, contact_id: C, line1: "Calle 1 # 2-3", city: "Medellín", country: "CO", city_code: "05001", state_code: "05", ...o,
});
const prof = (o: Partial<BillingProfileRow> = {}): BillingProfileRow => ({
  id: "p1", tenant_id: T, client_id: C, document_type_code: "13", document_number: "1000", legal_name: "X", email: "x@example.com", phone: null,
  organization_type: "2", tax_level_code: "R-99-PN", tax_scheme_code: null, applies_withholding: false,
  address_line1: null, country: null, ...o,
});
const base = { tenantId: T, contactId: C };

Deno.test("delivery exige destino; pickup y on_site no", () => {
  assertEquals(evaluateFulfillmentAndBilling({ ...base, fulfillmentMethod: "delivery" }).missingDestination, ["dirección de entrega"]);
  assertEquals(evaluateFulfillmentAndBilling({ ...base, fulfillmentMethod: "pickup" }).ok, true);
  assertEquals(evaluateFulfillmentAndBilling({ ...base, fulfillmentMethod: "on_site" }).ok, true);
  const ok = evaluateFulfillmentAndBilling({ ...base, fulfillmentMethod: "delivery", shippingAddressIdGiven: "a1", shippingAddress: addr() });
  assertEquals(ok.ok, true);
  assertEquals(ok.normalized.shipping_address_id, "a1");
  // texto de relleno no es dirección; "Colina" no es relleno
  assertEquals(evaluateFulfillmentAndBilling({ ...base, fulfillmentMethod: "delivery", shippingAddressIdGiven: "a1", shippingAddress: addr({ line1: "Dirección no registrada" }) }).ok, false);
  assertEquals(evaluateFulfillmentAndBilling({ ...base, fulfillmentMethod: "delivery", shippingAddressIdGiven: "a1", shippingAddress: addr({ line1: "Avenida Colina 5" }) }).ok, true);
  assertEquals(isPlaceholderAddressText("Avenida Colina 5"), false);
  assertEquals(isPlaceholderAddressText("N/A"), true);
});

Deno.test("delivery en Colombia: municipio+departamento DANE solo con requireDane", () => {
  const sin = addr({ city_code: null, state_code: null });
  assertEquals(evaluateFulfillmentAndBilling({ ...base, fulfillmentMethod: "delivery", shippingAddressIdGiven: "a1", shippingAddress: sin }).ok, true);
  const strict = evaluateFulfillmentAndBilling({ ...base, fulfillmentMethod: "delivery", shippingAddressIdGiven: "a1", shippingAddress: sin, requireDane: true });
  assertEquals(strict.missingDestination, ["municipio y departamento (DANE) de la dirección de entrega"]);
  // fuera de Colombia no se exige
  assertEquals(evaluateFulfillmentAndBilling({ ...base, fulfillmentMethod: "delivery", shippingAddressIdGiven: "a1", shippingAddress: addr({ country: "US", city_code: null, state_code: null }), requireDane: true }).ok, true);
  // pickup no pide DANE aunque se exija
  assertEquals(evaluateFulfillmentAndBilling({ ...base, fulfillmentMethod: "pickup", requireDane: true }).ok, true);
});

Deno.test("pertenencia: dirección o perfil de otro cliente/tenant, o inexistente", () => {
  assertEquals(evaluateFulfillmentAndBilling({ ...base, fulfillmentMethod: "pickup", shippingAddressIdGiven: "a1", shippingAddress: addr({ contact_id: "otro" }) }).forbidden.length, 1);
  assertEquals(evaluateFulfillmentAndBilling({ ...base, fulfillmentMethod: "pickup", shippingAddressIdGiven: "a1", shippingAddress: addr({ tenant_id: "t2" }) }).forbidden.length, 1);
  assertEquals(evaluateFulfillmentAndBilling({ ...base, fulfillmentMethod: "pickup", shippingAddressIdGiven: "zzz", shippingAddress: null }).forbidden.length, 1);
  const ajeno = evaluateFulfillmentAndBilling({ ...base, fulfillmentMethod: "on_site", billingProfileIdGiven: "p1", billingProfile: prof({ client_id: "otro" }), invoiceRequested: true });
  assertEquals(ajeno.forbidden, ["El perfil de facturación no pertenece al cliente del pedido."]);
  assertEquals(ajeno.normalized.billing_profile_id, null);
  assertEquals(evaluateFulfillmentAndBilling({ ...base, fulfillmentMethod: "on_site", billingProfileIdGiven: "p1", billingProfile: prof({ tenant_id: "t2" }) }).ok, false);
  assertEquals(evaluateFulfillmentAndBilling({ ...base, fulfillmentMethod: "on_site", billingProfileIdGiven: "p1", billingProfile: null }).ok, false);
  const bien = evaluateFulfillmentAndBilling({ ...base, fulfillmentMethod: "on_site", billingProfileIdGiven: "p1", billingProfile: prof() });
  assertEquals(bien.ok, true);
  assertEquals(bien.normalized.billing_profile_id, "p1");
});

Deno.test("factura pedida: los faltantes son los MISMOS que buildFiscalBuyer", () => {
  const client = { id: C, is_walk_in: false };
  const incompletos = [prof({ legal_name: null, email: null }), prof({ document_type_code: "31", document_number: "900123456-1" }), prof({ country: "CO", address_line1: "x", city_code: null, state_code: null })];
  for (const p of incompletos) {
    const r = evaluateFulfillmentAndBilling({ ...base, fulfillmentMethod: "on_site", billingProfileIdGiven: p.id, billingProfile: p, invoiceRequested: true, client });
    assertEquals(r.missingBilling, buildFiscalBuyer({ client, profile: p }).missing);
    assertEquals(r.missingBilling.length > 0, true);
  }
  // sin factura pedida no se exige el perfil completo
  assertEquals(evaluateFulfillmentAndBilling({ ...base, fulfillmentMethod: "on_site", billingProfileIdGiven: "p1", billingProfile: incompletos[0] }).ok, true);
  // cliente sin perfil que no es walk-in
  assertEquals(evaluateFulfillmentAndBilling({ ...base, fulfillmentMethod: "on_site", invoiceRequested: true, client }).missingBilling, ["perfil de facturación"]);
  // walk-in: el correo del comprobante es OPCIONAL (FAK55); si se manda debe ser válido
  const walk = { id: C, is_walk_in: true };
  assertEquals(evaluateFulfillmentAndBilling({ ...base, fulfillmentMethod: "on_site", invoiceRequested: true, client: walk }).ok, true);
  assertEquals(evaluateFulfillmentAndBilling({ ...base, fulfillmentMethod: "on_site", invoiceRequested: true, client: walk, invoiceEmail: "a@b.co" }).ok, true);
  assertEquals(evaluateFulfillmentAndBilling({ ...base, fulfillmentMethod: "on_site", invoiceRequested: true, client: walk, invoiceEmail: "mal" }).missingBilling, ["correo de facturación válido"]);
});

Deno.test("utilidades: método válido, snapshot de destino y errores 23503", () => {
  assertEquals(isFulfillmentMethod("pickup"), true);
  assertEquals(isFulfillmentMethod("ship"), false);
  const snap = buildShippingSnapshot(addr({ recipient_name: "Ana" }), new Date("2026-11-11T00:00:00Z"));
  assertEquals(snap.address_id, "a1");
  assertEquals(snap.recipient_name, "Ana");
  assertEquals(snap.frozen_at, "2026-11-11T00:00:00.000Z");
  assertEquals(describeOrderLinkError({ code: "23503", message: "SHIPPING_ADDRESS_OWNER: x" })?.status, 409);
  assertEquals(describeOrderLinkError({ code: "23503", message: 'violates "sales_orders_billing_profile_fkey"' })?.status, 409);
  assertEquals(describeOrderLinkError({ code: "23505", message: "x" }), null);
});

Deno.test("L4: sin cliente en el pedido no se acepta dirección ni perfil de nadie", () => {
  const sinCliente = { tenantId: T, contactId: null, fulfillmentMethod: "pickup" as const };
  assertEquals(evaluateFulfillmentAndBilling({ ...sinCliente, shippingAddressIdGiven: "a1", shippingAddress: addr() }).forbidden.length, 1);
  assertEquals(evaluateFulfillmentAndBilling({ ...sinCliente, billingProfileIdGiven: "p1", billingProfile: prof() }).forbidden.length, 1);
});

Deno.test("destino de un solo uso: mismas reglas que una dirección guardada", () => {
  const ok = evaluateFulfillmentAndBilling({ ...base, fulfillmentMethod: "delivery", shippingDestination: { line1: "Calle 5 # 6-7", city: "Cali", country: "CO" } });
  assertEquals(ok.ok, true);
  assertEquals(ok.normalized.shipping_snapshot?.line1, "Calle 5 # 6-7");
  assertEquals(ok.normalized.shipping_snapshot?.address_id, null);
  assertEquals(ok.normalized.shipping_snapshot?.one_off, true);
  assertEquals(ok.normalized.shipping_address_id, null);
  // sin línea 1 o con relleno: falta la dirección
  assertEquals(evaluateFulfillmentAndBilling({ ...base, fulfillmentMethod: "delivery", shippingDestination: { city: "Cali" } }).missingDestination, ["dirección de entrega"]);
  assertEquals(evaluateFulfillmentAndBilling({ ...base, fulfillmentMethod: "delivery", shippingDestination: { line1: "Sin dirección" } }).ok, false);
  // un destino a medias tampoco se acepta fuera de delivery
  assertEquals(evaluateFulfillmentAndBilling({ ...base, fulfillmentMethod: "pickup", shippingDestination: { line1: " " } }).ok, false);
  // DANE solo con requireDane, Colombia y delivery
  const sinDane = { line1: "Calle 1", country: "CO" };
  assertEquals(evaluateFulfillmentAndBilling({ ...base, fulfillmentMethod: "delivery", shippingDestination: sinDane }).ok, true);
  assertEquals(evaluateFulfillmentAndBilling({ ...base, fulfillmentMethod: "delivery", shippingDestination: sinDane, requireDane: true }).missingDestination.length, 1);
  assertEquals(evaluateFulfillmentAndBilling({ ...base, fulfillmentMethod: "delivery", shippingDestination: { ...sinDane, city_code: "05001", state_code: "05" }, requireDane: true }).ok, true);
  assertEquals(evaluateFulfillmentAndBilling({ ...base, fulfillmentMethod: "delivery", shippingDestination: { line1: "1 Main", country: "US" }, requireDane: true }).ok, true);
  // excluyente con una dirección de la libreta
  const ambos = evaluateFulfillmentAndBilling({ ...base, fulfillmentMethod: "delivery", shippingAddressIdGiven: "a1", shippingAddress: addr(), shippingDestination: { line1: "X 1" } });
  assertEquals(ambos.forbidden.length, 1);
  assertEquals(ambos.normalized.shipping_snapshot, null);
});

Deno.test("normalizeShippingDestination: solo claves conocidas, trim, vacío -> null", () => {
  assertEquals(normalizeShippingDestination(null), null);
  assertEquals(normalizeShippingDestination([1]), null);
  assertEquals(normalizeShippingDestination("x"), null);
  const d = normalizeShippingDestination({ line1: "  Calle 1 ", phone: "", evil: "x", city_code: "05001", notes: 5 });
  assertEquals(d?.line1, "Calle 1");
  assertEquals(d?.phone, null);
  assertEquals(d?.city_code, "05001");
  assertEquals(d?.notes, null);
  assertEquals("evil" in (d as object), false);
  assertEquals(buildOneOffSnapshot({ line1: "A 1" }, new Date("2026-11-12T00:00:00Z")).frozen_at, "2026-11-12T00:00:00.000Z");
});

Deno.test("billing_profile_mismatch: reintento con otro 'Facturar a' se detecta; undefined no se compara", () => {
  assertEquals(billingProfileMismatch("p2", "p1"), true);
  assertEquals(billingProfileMismatch(null, "p1"), true);
  assertEquals(billingProfileMismatch("p1", null), true);
  assertEquals(billingProfileMismatch("p1", "p1"), false);
  assertEquals(billingProfileMismatch(null, null), false);
  assertEquals(billingProfileMismatch(undefined, "p1"), false);
});
