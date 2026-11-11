import { assertEquals } from "jsr:@std/assert@1";
import { buildFiscalBuyer } from "../../functions/_shared/invoicing/clientBillingProfile.ts";
import { buildInvoiceXml, invoiceFixtureToInput, parseXml } from "./harness.ts";
import { SYNTHETIC_INVOICES } from "./fixtures_synthetic.ts";

const client = {
  id: "client", full_name: "Contacto comercial", phone: "", email: "contacto@example.com",
  document_number: "900.123.456-8", dian_document_type_code: "31", applies_withholding: false, is_walk_in: false,
};

Deno.test("perfil fiscal: prepara NIT, razón social y dirección para la factura", async () => {
  const { buyer, missing } = buildFiscalBuyer({
    ...client, document_number: "900.123.456",
    billing_profile: {
      legal_name: "Nombre del RUT", tax_level_code: "O-13;O-23",
      tax_scheme_code: "ZZ", email: "facturas@example.com",
      address: { line1: "Calle 1", country: "CO", city: "Bogotá", state_province: "Bogotá", city_code: "11001", state_code: "11" },
    },
  });
  assertEquals(missing, []);
  assertEquals(buyer.document_number, "900123456");
  assertEquals(buyer.email, "facturas@example.com");
  const { input } = invoiceFixtureToInput(SYNTHETIC_INVOICES[0]);
  input.buyer = {
    legalName: buyer.full_name!, documentNumber: buyer.document_number!, documentTypeCode: buyer.document_type_code!,
    organizationType: buyer.organization_type!, taxLevelCode: buyer.tax_level_code, taxSchemeCode: buyer.tax_scheme_code!,
    addressLine: buyer.address!.line1, city: buyer.address!.city, stateProvince: buyer.address!.state_province,
    countryCode: buyer.address!.country!, cityCode: buyer.address!.city_code, stateCode: buyer.address!.state_code,
    electronicMail: buyer.email,
  };
  const { xml } = await buildInvoiceXml(input);
  const party = parseXml(xml).getElementsByTagName("cac:AccountingCustomerParty")[0];
  assertEquals(party.getElementsByTagName("cbc:AdditionalAccountID")[0].textContent, "1");
  assertEquals(party.getElementsByTagName("cbc:TaxLevelCode")[0].textContent, "O-13;O-23");
  assertEquals(party.getElementsByTagName("cac:TaxScheme")[0].getElementsByTagName("cbc:ID")[0].textContent, "ZZ");
  assertEquals(party.getElementsByTagName("cbc:Line")[0].textContent, "Calle 1");
});

Deno.test("perfil fiscal: requiere correo válido también para consumidor final", () => {
  const incomplete = buildFiscalBuyer({
    ...client, email: null, billing_profile: {
      address: { line1: "Calle 1", country: "CO", city: null, state_province: null },
    },
  });
  assertEquals(incomplete.buyer.organization_type, "1");
  assertEquals(incomplete.missing.includes("departamento y municipio de la dirección fiscal"), true);
  assertEquals(incomplete.missing.includes("correo de facturación"), true);
  const walkIn = buildFiscalBuyer({
    ...client, full_name: "Consumidor final", document_number: "222222222222", dian_document_type_code: "13",
    email: null, is_walk_in: true,
  });
  assertEquals(walkIn.missing, ["correo de facturación"]);
  assertEquals(walkIn.buyer.address, null);
  const fromContact = buildFiscalBuyer({
    ...client, document_number: "123456", dian_document_type_code: "13",
  });
  assertEquals(fromContact.missing, []);
  assertEquals(fromContact.buyer.organization_type, "2");
  assertEquals(fromContact.buyer.email, "contacto@example.com");
  const invalid = buildFiscalBuyer({
    ...client, document_number: "123456", dian_document_type_code: "13", email: "sin-arroba",
  });
  assertEquals(invalid.missing, ["correo de facturación válido"]);
});
