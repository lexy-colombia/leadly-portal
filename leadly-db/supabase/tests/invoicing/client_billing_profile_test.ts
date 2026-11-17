import { assertEquals } from "jsr:@std/assert@1";
import { buildFiscalBuyer, loadBillingProfileForOrder, type BillingProfileRow, type FiscalClientRef } from "../../functions/_shared/invoicing/clientBillingProfile.ts";
import { parseInvoiceEmail } from "../../functions/_shared/invoicing/invoiceEmail.ts";
import { previousInvoiceEmail } from "../../functions/_shared/invoicing/queueInvoiceGeneration.ts";
import { mapInvoiceBuyer } from "../../functions/_shared/invoicing/invoiceInput.ts";
import { buildInvoiceXml, invoiceFixtureToInput, parseXml } from "./harness.ts";
import { SYNTHETIC_INVOICES } from "./fixtures_synthetic.ts";

const client: FiscalClientRef = { id: "client", is_walk_in: false, full_name: "Contacto comercial", document_number: "NO-DEBE-USARSE", dian_document_type_code: "13" };
const walkIn: FiscalClientRef = { id: "walkin", is_walk_in: true, full_name: "Consumidor final", document_number: "222222222222", dian_document_type_code: "13" };

function profile(over: Partial<BillingProfileRow> = {}): BillingProfileRow {
  return {
    id: "p1", tenant_id: "t", client_id: "client", label: "Principal", is_default: true,
    document_type_code: "13", document_number: "79123456", legal_name: "MARIA PEREZ", email: "maria@example.com", phone: "3001112233",
    organization_type: "2", tax_level_code: "R-99-PN", tax_scheme_code: "ZZ", applies_withholding: false,
    address_line1: "Calle 1 # 2-3", address_line2: null, country: "CO", state_code: "11", city_code: "11001", state_province: "Bogotá D.C.", city: "Bogotá D.C.",
    ...over,
  };
}

Deno.test("perfil: persona natural con cédula, sin respaldo desde clients", () => {
  const { buyer, missing } = buildFiscalBuyer({ client, profile: profile() });
  assertEquals(missing, []);
  // El documento sale del PERFIL, no de clients (cuyo document_number es una trampa).
  assertEquals(buyer.document_number, "79123456");
  assertEquals(buyer.document_type_code, "13");
  assertEquals(buyer.full_name, "MARIA PEREZ");
  assertEquals(buyer.billing_profile_id, "p1");
  assertEquals(buyer.organization_type, "2");
  assertEquals(buyer.phone, "3001112233");
});

Deno.test("perfil: empresa con NIT y DV; normaliza el NIT y valida el dígito", async () => {
  const ok = buildFiscalBuyer({
    client,
    profile: profile({ document_type_code: "31", document_number: "900.123.456-8", legal_name: "EMPRESA SAS", organization_type: "1", tax_level_code: "O-13;O-23", tax_scheme_code: "01", email: "facturas@example.com" }),
  });
  assertEquals(ok.missing, []);
  assertEquals(ok.buyer.document_number, "900123456");
  assertEquals(ok.buyer.organization_type, "1");
  const bad = buildFiscalBuyer({ client, profile: profile({ document_type_code: "31", document_number: "900123456-1" }) });
  assertEquals(bad.missing, ["dígito de verificación válido"]);
  const nitMalo = buildFiscalBuyer({ client, profile: profile({ document_type_code: "31", document_number: "ABC" }) });
  assertEquals(nitMalo.missing, ["NIT válido"]);

  // El comprador del perfil llega completo al XML (organización, régimen, esquema, correo).
  const { buyer } = ok;
  const { input } = invoiceFixtureToInput(SYNTHETIC_INVOICES[0]);
  input.buyer = mapInvoiceBuyer({ ...buyer, address: buyer.address });
  const { xml } = await buildInvoiceXml(input);
  const party = parseXml(xml).getElementsByTagName("cac:AccountingCustomerParty")[0];
  assertEquals(party.getElementsByTagName("cbc:AdditionalAccountID")[0].textContent, "1");
  assertEquals(party.getElementsByTagName("cbc:TaxLevelCode")[0].textContent, "O-13;O-23");
  assertEquals(party.getElementsByTagName("cac:TaxScheme")[0].getElementsByTagName("cbc:ID")[0].textContent, "01");
  assertEquals(party.getElementsByTagName("cbc:Line")[0].textContent, "Calle 1 # 2-3");
});

Deno.test("perfil: extranjero sin DIVIPOLA (domicilio fuera de Colombia)", () => {
  const { buyer, missing } = buildFiscalBuyer({
    client,
    profile: profile({ document_type_code: "41", document_number: "X1234567", legal_name: "JOHN DOE", email: "john@example.com", country: "US", state_code: null, city_code: null, city: "Miami", address_line1: "1 Main St" }),
  });
  assertEquals(missing, []);
  assertEquals(buyer.address?.country, "US");
});

Deno.test("perfil incompleto: faltantes exactos, sin respaldo desde clients", () => {
  const incomplete = buildFiscalBuyer({
    client,
    profile: profile({ legal_name: null, email: null, document_number: null, country: "CO", city_code: null, state_code: null }),
  });
  assertEquals(incomplete.missing, [
    "nombre legal o razón social",
    "número de documento del cliente",
    "departamento y municipio de la dirección fiscal",
  ]);
  // Sin perfil y no walk-in: se pide el perfil, no se inventa nada desde clients.
  const sinPerfil = buildFiscalBuyer({ client, profile: null });
  assertEquals(sinPerfil.missing, ["perfil de facturación"]);
  assertEquals(sinPerfil.buyer.document_number, null);
  assertEquals(sinPerfil.buyer.full_name, null);
  const invalid = buildFiscalBuyer({ client, profile: profile({ email: "sin-arroba" }) });
  assertEquals(invalid.missing, ["correo de facturación válido"]);
  // Sin domicilio fiscal: es válido (venta de mostrador a cédula sin domicilio).
  const sinDomicilio = buildFiscalBuyer({ client, profile: profile({ address_line1: null, country: null, city: null, city_code: null, state_code: null, state_province: null }) });
  assertEquals(sinDomicilio.missing, []);
  assertEquals(sinDomicilio.buyer.address, null);
});

Deno.test("Consumidor Final: documento 222222222222; correo OPCIONAL por comprobante (nunca de la ficha)", () => {
  const sinCorreo = buildFiscalBuyer({ client: walkIn, profile: null });
  // FAK55: para consumidor final ElectronicMail es opcional -> no bloquea.
  assertEquals(sinCorreo.missing, []);
  assertEquals(sinCorreo.buyer.email, null);
  assertEquals(sinCorreo.buyer.email_source, null);
  assertEquals(sinCorreo.buyer.document_number, "222222222222");
  assertEquals(sinCorreo.buyer.address, null);
  const conCorreo = buildFiscalBuyer({ client: walkIn, profile: null, invoiceEmail: "final@example.com" });
  assertEquals(conCorreo.missing, []);
  assertEquals(conCorreo.buyer.email, "final@example.com");
  assertEquals(conCorreo.buyer.tax_level_code, "R-99-PN");
  assertEquals(buildFiscalBuyer({ client: walkIn, profile: null, invoiceEmail: "mal" }).missing, ["correo de facturación válido"]);
  // El correo del comprobante NO se aplica a un cliente con perfil.
  const conPerfil = buildFiscalBuyer({ client, profile: profile({ email: null }), invoiceEmail: "otro@example.com" });
  assertEquals(conPerfil.missing, []);
  assertEquals(conPerfil.buyer.email, null);
});

Deno.test("B1: el walk-in IGNORA is_default y cualquier perfil (no se factura a un tercero)", () => {
  const tercero = profile({ id: "tercero", client_id: "walkin", is_default: true, document_type_code: "31", document_number: "900999888", legal_name: "TERCERO SA", email: "tercero@example.com" });
  const r = buildFiscalBuyer({ client: walkIn, profile: tercero, invoiceEmail: "final@example.com" });
  assertEquals(r.missing, []);
  assertEquals(r.buyer.document_number, "222222222222");
  assertEquals(r.buyer.full_name, "Consumidor final");
  assertEquals(r.buyer.email, "final@example.com");
  assertEquals(r.buyer.billing_profile_id, null);
  // sin invoice_email: sin correo (pending), nunca con el correo del perfil del tercero
  const sin = buildFiscalBuyer({ client: walkIn, profile: tercero });
  assertEquals(sin.missing, []);
  assertEquals(sin.buyer.email, null);
  assertEquals(sin.buyer.document_number, "222222222222");
});

Deno.test("B2: el correo de un walk-in solo es reutilizable si vino de invoice_email", () => {
  assertEquals(buildFiscalBuyer({ client: walkIn, profile: null, invoiceEmail: "a@example.com" }).buyer.email_source, "invoice_email");
  assertEquals(buildFiscalBuyer({ client: walkIn, profile: null }).buyer.email_source, null);
  assertEquals(buildFiscalBuyer({ client, profile: profile() }).buyer.email_source, "billing_profile");
});

Deno.test("loadBillingProfileForOrder: el walk-in no carga ningun perfil (ni sin consultar)", async () => {
  const boom = { from: () => { throw new Error("no debe consultar"); } };
  assertEquals(await loadBillingProfileForOrder(boom, "t", "walkin", null, true), { profile: null, chosenMissing: false });
  assertEquals(await loadBillingProfileForOrder(boom, "t", "walkin", "p-explicito", true), { profile: null, chosenMissing: false });
});

// deno-lint-ignore no-explicit-any
function fakeInvoices(rows: any[]): any {
  const chain: any = { select: () => chain, eq: () => chain, order: () => chain, limit: () => Promise.resolve({ data: rows }) };
  return { from: () => chain };
}
Deno.test("M1: el reintento de un walk-in parte del invoice_email del intento anterior (solo si vino de invoice_email)", async () => {
  const prev = [
    { buyer_snapshot: { email: "ficha@walkin.co", email_source: null } },
    { buyer_snapshot: { email: "capturado@example.com", email_source: "invoice_email" } },
  ];
  assertEquals(await previousInvoiceEmail(fakeInvoices(prev), "t", "o"), "capturado@example.com");
  assertEquals(await previousInvoiceEmail(fakeInvoices([{ buyer_snapshot: { email: "ficha@walkin.co" } }]), "t", "o"), null);
  assertEquals(await previousInvoiceEmail(fakeInvoices([]), "t", "o"), null);
});

Deno.test("L1: parseInvoiceEmail valida tipo, longitud y formato", () => {
  assertEquals(parseInvoiceEmail("  a@b.co "), "a@b.co");
  assertEquals(parseInvoiceEmail(123), null);
  assertEquals(parseInvoiceEmail({}), null);
  assertEquals(parseInvoiceEmail("a<b>@b.co"), null);
  assertEquals(parseInvoiceEmail('a&"@b.co'), null);
  assertEquals(parseInvoiceEmail("a b@b.co"), null);
  assertEquals(parseInvoiceEmail("sin-arroba"), null);
  assertEquals(parseInvoiceEmail("a@b"), null);
  assertEquals(parseInvoiceEmail("a".repeat(250) + "@b.co"), null);
  assertEquals(parseInvoiceEmail(""), null);
});

Deno.test("XML: Consumidor Final sin correo NO emite cac:Contact del adquirente; con invoice_email sí", async () => {
  const sin = SYNTHETIC_INVOICES.find((f) => f.label === "inc8-consumidor-final")!;
  const con = SYNTHETIC_INVOICES.find((f) => f.label === "perfil-consumidor-final-correo")!;
  const buyerParty = async (fx: typeof sin) => {
    const { xml } = await buildInvoiceXml(invoiceFixtureToInput(fx).input);
    return parseXml(xml).getElementsByTagName("cac:AccountingCustomerParty")[0];
  };
  const pSin = await buyerParty(sin);
  assertEquals(pSin.getElementsByTagName("cac:Contact").length, 0);
  assertEquals(pSin.getElementsByTagName("cbc:ElectronicMail").length, 0);
  const pCon = await buyerParty(con);
  assertEquals(pCon.getElementsByTagName("cbc:ElectronicMail")[0].textContent, "cliente.final@example.invalid");
  // el comprador armado por buildFiscalBuyer sin correo produce el mismo XML (sin Contact)
  const { buyer } = buildFiscalBuyer({ client: walkIn, profile: null });
  const { input } = invoiceFixtureToInput(sin);
  input.buyer = mapInvoiceBuyer(buyer);
  const { xml } = await buildInvoiceXml(input);
  assertEquals(parseXml(xml).getElementsByTagName("cac:AccountingCustomerParty")[0].getElementsByTagName("cac:Contact").length, 0);
});

Deno.test("Ronda 5: perfil CON NOMBRE sin correo no bloquea; con correo inválido sí; sin Contact en el XML", async () => {
  const sin = buildFiscalBuyer({ client, profile: profile({ email: null }) });
  assertEquals(sin.missing, []);
  assertEquals(sin.buyer.email, null);
  assertEquals(sin.buyer.email_source, null);
  assertEquals(buildFiscalBuyer({ client, profile: profile({ email: "   " }) }).missing, []);
  assertEquals(buildFiscalBuyer({ client, profile: profile({ email: "sin-arroba" }) }).missing, ["correo de facturación válido"]);
  // el resto de faltantes no cambia
  assertEquals(buildFiscalBuyer({ client, profile: profile({ email: null, legal_name: null, document_number: null }) }).missing, ["nombre legal o razón social", "número de documento del cliente"]);
  const { input } = invoiceFixtureToInput(SYNTHETIC_INVOICES[0]);
  input.buyer = mapInvoiceBuyer(sin.buyer);
  const { xml } = await buildInvoiceXml(input);
  assertEquals(parseXml(xml).getElementsByTagName("cac:AccountingCustomerParty")[0].getElementsByTagName("cac:Contact").length, 0);
});
