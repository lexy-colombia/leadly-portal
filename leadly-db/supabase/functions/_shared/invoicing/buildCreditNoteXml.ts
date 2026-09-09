/** Construcción del XML UBL 2.1 de la Nota Crédito Electrónica -- mismo
 * criterio de fuentes que buildInvoiceXml.ts: el texto del Anexo Técnico
 * v1.9 (Resolución 000165 de 2023, sección 6.2 "Nota Crédito: CreditNote"
 * y 8.3.1 "Línea de Nota Crédito: CreditNoteLine") para valores/estructura.
 *
 * Diferencias reales contra una Invoice, todas confirmadas en el texto del
 * Anexo (no supuestas):
 * - Raíz `CreditNote` (namespace `...CreditNote-2`), no `Invoice`.
 * - `cbc:CustomizationID` = "20" ("Nota Crédito de Factura Electrónica de
 *   Venta", CAD02/CBF01 -- exige que exista `cac:BillingReference` una
 *   sola vez).
 * - `cbc:ProfileID` = literal EXACTO "DIAN 2.1: Nota Crédito de Factura
 *   Electrónica de Venta" (CAD03 -- rechazo si no coincide carácter a
 *   carácter, a diferencia del "DIAN 2.1" corto de la factura).
 * - `cbc:CreditNoteTypeCode` = "91" (tabla 13.1.3 "Tipo de Documento" --
 *   valor estándar y universal en todo el ecosistema de facturación
 *   electrónica colombiana, no específico de este Anexo).
 * - `cbc:UUID` = CUDE (no CUFE, ver cufe.ts::computeCude), `@schemeName`
 *   literal "CUDE-SHA384" (confirmado, línea 689/14268/17958 del Anexo).
 * - `cac:DiscrepancyResponse` (motivo de la corrección) y
 *   `cac:BillingReference/cac:InvoiceDocumentReference` (referencia a la
 *   factura original: ID+CUFE+fecha) -- ninguno de los dos existe en
 *   Invoice.
 * - `ext:UBLExtensions/.../sts:DianExtensions` NO lleva `sts:InvoiceControl`
 *   (ni AuthorizationPeriod/AuthorizedInvoices) -- confirmado por omisión en
 *   el Anexo: una nota crédito no tiene rango de numeración autorizado por
 *   la DIAN, así que no hay nada que declarar ahí. Sí lleva
 *   InvoiceSource/SoftwareProvider/SoftwareSecurityCode/
 *   AuthorizationProvider/QRCode, igual que la factura.
 * - `cac:CreditNoteLine` en vez de `cac:InvoiceLine`, con
 *   `cbc:CreditedQuantity` en vez de `cbc:InvoicedQuantity` (confirmado,
 *   CAV04a/b) -- el resto de la línea (Item/Price/TaxTotal) es idéntico.
 *
 * ⚠️ El contenido exacto de `sts:QRCode` para una Nota Crédito no pudo
 * confirmarse sin ambigüedad en el texto extraído del Anexo (la
 * observación de esa fila mezcla, aparentemente por un artefacto de
 * extracción de una tabla con columnas envueltas, una referencia al UUID
 * de `cac:BillingReference` que no tiene sentido tomar literal). Se optó
 * por el diseño consistente con TODO el resto del ecosistema de
 * facturación electrónica colombiana y con el propio criterio de
 * buildInvoiceXml.ts: el QR de un documento apunta a la identidad de ESE
 * documento (su propio CUDE), igual que el de la factura apunta a su
 * propio CUFE -- no a la factura que corrige. Pendiente confirmar contra
 * una respuesta real de la DIAN. */

import { computeCude, computeSoftwareSecurityCode } from "./cufe.ts";
import { computeNitCheckDigit } from "./nit.ts";

const TAX_SCHEME_NAME: Record<string, string> = { "01": "IVA", "03": "ICA", "04": "INC" };

export interface CreditNoteXmlParty {
  legalName: string;
  documentTypeCode: string;
  documentNumber: string;
  addressLine: string;
  city: string;
  stateProvince: string;
  countryCode: string;
}

export interface CreditNoteXmlTax {
  code: string; // "01" | "04" | "03"
  rate: number;
  taxableAmount: number;
  taxAmount: number;
}

export interface BuildCreditNoteXmlInput {
  creditNoteId: string; // prefijo + consecutivo, ej. "NCSETP1"
  issueDate: string; // YYYY-MM-DD
  issueTime: string; // HH:MM:SS-05:00
  currency: string;
  environment: 1 | 2;
  seller: CreditNoteXmlParty;
  buyer: CreditNoteXmlParty;
  /** Referencia a la factura que esta nota corrige -- obligatoria
   * (CustomizationID=20 exige BillingReference una vez). */
  referencedInvoice: {
    id: string; // prefijo + número de la factura, ej. "SETP990000001"
    cufe: string;
    issueDate: string; // YYYY-MM-DD
  };
  /** Motivo de la corrección (CBF03/CBF04) -- código 1-6 de la tabla DIAN
   * de conceptos, ver RETURN_REASONS-como-constante en el frontend. */
  reasonCode: string;
  reasonDescription: string;
  /** Una única línea sintética de "ajuste" -- ver comentario de cabecera
   * de la migración sales_credit_notes sobre por qué no hay un editor de
   * ítems en v1. */
  line: {
    description: string;
    amount: number; // monto tax-inclusive de la línea (= subtotal + tax)
    tax: CreditNoteXmlTax | null;
  };
  softwareId: string;
  softwarePin: string;
  authorizationProviderNit: string;
}

function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function money(value: number): string {
  const truncated = Math.trunc(value * 100) / 100;
  return truncated.toFixed(2);
}

function partyBlock(tag: "cac:AccountingSupplierParty" | "cac:AccountingCustomerParty", party: CreditNoteXmlParty, dv?: number): string {
  const companyIdAttrs = `schemeAgencyID="195" schemeAgencyName="CO, DIAN (Dirección de Impuestos y Aduanas Nacionales)"${
    dv !== undefined ? ` schemeID="${dv}"` : ""
  } schemeName="${esc(party.documentTypeCode)}"`;
  return `
   <${tag}>
      <cac:Party>
         <cac:PartyName>
            <cbc:Name>${esc(party.legalName)}</cbc:Name>
         </cac:PartyName>
         <cac:PhysicalLocation>
            <cac:Address>
               <cbc:CityName>${esc(party.city)}</cbc:CityName>
               <cbc:CountrySubentity>${esc(party.stateProvince)}</cbc:CountrySubentity>
               <cac:AddressLine>
                  <cbc:Line>${esc(party.addressLine)}</cbc:Line>
               </cac:AddressLine>
               <cac:Country>
                  <cbc:IdentificationCode>${esc(party.countryCode)}</cbc:IdentificationCode>
                  <cbc:Name languageID="es">Colombia</cbc:Name>
               </cac:Country>
            </cac:Address>
         </cac:PhysicalLocation>
         <cac:PartyTaxScheme>
            <cbc:RegistrationName>${esc(party.legalName)}</cbc:RegistrationName>
            <cbc:CompanyID ${companyIdAttrs}>${esc(party.documentNumber)}</cbc:CompanyID>
            <cac:RegistrationAddress>
               <cbc:CityName>${esc(party.city)}</cbc:CityName>
               <cbc:CountrySubentity>${esc(party.stateProvince)}</cbc:CountrySubentity>
               <cac:AddressLine>
                  <cbc:Line>${esc(party.addressLine)}</cbc:Line>
               </cac:AddressLine>
               <cac:Country>
                  <cbc:IdentificationCode>${esc(party.countryCode)}</cbc:IdentificationCode>
                  <cbc:Name languageID="es">Colombia</cbc:Name>
               </cac:Country>
            </cac:RegistrationAddress>
            <cac:TaxScheme>
               <cbc:ID>01</cbc:ID>
               <cbc:Name>IVA</cbc:Name>
            </cac:TaxScheme>
         </cac:PartyTaxScheme>
         <cac:PartyLegalEntity>
            <cbc:RegistrationName>${esc(party.legalName)}</cbc:RegistrationName>
            <cbc:CompanyID ${companyIdAttrs}>${esc(party.documentNumber)}</cbc:CompanyID>
         </cac:PartyLegalEntity>
      </cac:Party>
   </${tag}>`;
}

export async function buildCreditNoteXml(input: BuildCreditNoteXmlInput): Promise<{ xml: string; cude: string }> {
  const tax = input.line.tax;
  const taxAmount = tax?.taxAmount ?? 0;
  const subtotal = input.line.amount - taxAmount;
  const taxInclusiveAmount = input.line.amount;
  const payableAmount = taxInclusiveAmount;

  const ivaTotal = tax?.code === "01" ? taxAmount : 0;
  const incTotal = tax?.code === "04" ? taxAmount : 0;
  const icaTotal = tax?.code === "03" ? taxAmount : 0;

  const sellerDv = computeNitCheckDigit(input.seller.documentNumber);
  const buyerDv = computeNitCheckDigit(input.buyer.documentNumber);

  const cude = await computeCude({
    numFac: input.creditNoteId,
    fecFac: input.issueDate,
    horFac: input.issueTime,
    valFac: subtotal,
    valImp1Iva: ivaTotal,
    valImp2Inc: incTotal,
    valImp3Ica: icaTotal,
    valTot: taxInclusiveAmount,
    nitOfe: input.seller.documentNumber,
    numAdq: input.buyer.documentNumber,
    softwarePin: input.softwarePin,
    tipoAmbiente: input.environment,
  });

  const softwareSecurityCode = await computeSoftwareSecurityCode(input.softwareId, input.softwarePin, input.creditNoteId);

  const qrHost = input.environment === 1 ? "https://catalogo-vpfe.dian.gov.co" : "https://catalogo-vpfe-hab.dian.gov.co";
  const qrContent = [
    `NroNotaCredito=${input.creditNoteId}`,
    `NitFacturador=${input.seller.documentNumber}`,
    `NitAdquiriente=${input.buyer.documentNumber}`,
    `FechaNotaCredito=${input.issueDate}`,
    `ValorTotalNotaCredito=${money(payableAmount)}`,
    `CUDE=${cude}`,
    `URL=${qrHost}/document/searchqr?documentkey=${cude}`,
  ].join("\n");

  const taxTotalBlocks = (["01", "04", "03"] as const)
    .map((code) => {
      const amount = code === "01" ? ivaTotal : code === "04" ? incTotal : icaTotal;
      const rate = tax?.code === code ? tax.rate : 0;
      const taxable = tax?.code === code ? tax.taxableAmount : 0;
      return `
   <cac:TaxTotal>
      <cbc:TaxAmount currencyID="${input.currency}">${money(amount)}</cbc:TaxAmount>
      <cac:TaxSubtotal>
         <cbc:TaxableAmount currencyID="${input.currency}">${money(taxable)}</cbc:TaxableAmount>
         <cbc:TaxAmount currencyID="${input.currency}">${money(amount)}</cbc:TaxAmount>
         <cac:TaxCategory>
            <cbc:Percent>${rate.toFixed(2)}</cbc:Percent>
            <cac:TaxScheme>
               <cbc:ID>${code}</cbc:ID>
               <cbc:Name>${TAX_SCHEME_NAME[code]}</cbc:Name>
            </cac:TaxScheme>
         </cac:TaxCategory>
      </cac:TaxSubtotal>
   </cac:TaxTotal>`;
    })
    .join("");

  const lineTaxXml = tax
    ? `
      <cac:TaxTotal>
         <cbc:TaxAmount currencyID="${input.currency}">${money(tax.taxAmount)}</cbc:TaxAmount>
         <cac:TaxSubtotal>
            <cbc:TaxableAmount currencyID="${input.currency}">${money(tax.taxableAmount)}</cbc:TaxableAmount>
            <cbc:TaxAmount currencyID="${input.currency}">${money(tax.taxAmount)}</cbc:TaxAmount>
            <cac:TaxCategory>
               <cbc:Percent>${tax.rate.toFixed(2)}</cbc:Percent>
               <cac:TaxScheme>
                  <cbc:ID>${tax.code}</cbc:ID>
                  <cbc:Name>${TAX_SCHEME_NAME[tax.code]}</cbc:Name>
               </cac:TaxScheme>
            </cac:TaxCategory>
         </cac:TaxSubtotal>
      </cac:TaxTotal>`
    : "";

  const lineXml = `
   <cac:CreditNoteLine>
      <cbc:ID>1</cbc:ID>
      <cbc:CreditedQuantity unitCode="EA">1.000000</cbc:CreditedQuantity>
      <cbc:LineExtensionAmount currencyID="${input.currency}">${money(subtotal)}</cbc:LineExtensionAmount>${lineTaxXml}
      <cac:Item>
         <cbc:Description>${esc(input.line.description)}</cbc:Description>
      </cac:Item>
      <cac:Price>
         <cbc:PriceAmount currencyID="${input.currency}">${money(subtotal)}</cbc:PriceAmount>
         <cbc:BaseQuantity unitCode="EA">1.000000</cbc:BaseQuantity>
      </cac:Price>
   </cac:CreditNoteLine>`;

  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="no"?><CreditNote xmlns="urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2" xmlns:sts="dian:gov:co:facturaelectronica:Structures-2-1" xmlns:xades="http://uri.etsi.org/01903/v1.3.2#" xmlns:xades141="http://uri.etsi.org/01903/v1.4.1#" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2     http://docs.oasis-open.org/ubl/os-UBL-2.1/xsd/maindoc/UBL-CreditNote-2.1.xsd">
   <ext:UBLExtensions>
      <ext:UBLExtension>
         <ext:ExtensionContent>
            <sts:DianExtensions>
               <sts:InvoiceSource>
                  <cbc:IdentificationCode listAgencyID="6" listAgencyName="United Nations Economic Commission for Europe" listSchemeURI="urn:oasis:names:specification:ubl:codelist:gc:CountryIdentificationCode-2.1">CO</cbc:IdentificationCode>
               </sts:InvoiceSource>
               <sts:SoftwareProvider>
                  <sts:ProviderID schemeAgencyID="195" schemeAgencyName="CO, DIAN (Dirección de Impuestos y Aduanas Nacionales)" schemeID="${sellerDv}" schemeName="31">${esc(input.seller.documentNumber)}</sts:ProviderID>
                  <sts:SoftwareID schemeAgencyID="195" schemeAgencyName="CO, DIAN (Dirección de Impuestos y Aduanas Nacionales)">${esc(input.softwareId)}</sts:SoftwareID>
               </sts:SoftwareProvider>
               <sts:SoftwareSecurityCode schemeAgencyID="195" schemeAgencyName="CO, DIAN (Dirección de Impuestos y Aduanas Nacionales)">${softwareSecurityCode}</sts:SoftwareSecurityCode>
               <sts:AuthorizationProvider>
                  <sts:AuthorizationProviderID schemeAgencyID="195" schemeAgencyName="CO, DIAN (Dirección de Impuestos y Aduanas Nacionales)" schemeID="${computeNitCheckDigit(input.authorizationProviderNit)}" schemeName="31">${esc(input.authorizationProviderNit)}</sts:AuthorizationProviderID>
               </sts:AuthorizationProvider>
               <sts:QRCode>${esc(qrContent)}</sts:QRCode>
            </sts:DianExtensions>
         </ext:ExtensionContent>
      </ext:UBLExtension>
      <ext:UBLExtension><ext:ExtensionContent/></ext:UBLExtension>
   </ext:UBLExtensions>
   <cbc:UBLVersionID>UBL 2.1</cbc:UBLVersionID>
   <cbc:CustomizationID>20</cbc:CustomizationID>
   <cbc:ProfileID>DIAN 2.1: Nota Crédito de Factura Electrónica de Venta</cbc:ProfileID>
   <cbc:ProfileExecutionID>${input.environment}</cbc:ProfileExecutionID>
   <cbc:ID>${esc(input.creditNoteId)}</cbc:ID>
   <cbc:UUID schemeID="${input.environment}" schemeName="CUDE-SHA384">${cude}</cbc:UUID>
   <cbc:IssueDate>${input.issueDate}</cbc:IssueDate>
   <cbc:IssueTime>${input.issueTime}</cbc:IssueTime>
   <cbc:CreditNoteTypeCode>91</cbc:CreditNoteTypeCode>
   <cbc:DocumentCurrencyCode listAgencyID="6" listAgencyName="United Nations Economic Commission for Europe" listID="ISO 4217 Alpha">${input.currency}</cbc:DocumentCurrencyCode>
   <cbc:LineCountNumeric>1</cbc:LineCountNumeric>${partyBlock("cac:AccountingSupplierParty", input.seller, sellerDv)}${partyBlock("cac:AccountingCustomerParty", input.buyer, buyerDv)}${taxTotalBlocks}
   <cac:DiscrepancyResponse>
      <cbc:ResponseCode>${esc(input.reasonCode)}</cbc:ResponseCode>
      <cbc:Description>${esc(input.reasonDescription)}</cbc:Description>
   </cac:DiscrepancyResponse>
   <cac:BillingReference>
      <cac:InvoiceDocumentReference>
         <cbc:ID>${esc(input.referencedInvoice.id)}</cbc:ID>
         <cbc:UUID schemeName="CUFE-SHA384">${input.referencedInvoice.cufe}</cbc:UUID>
         <cbc:IssueDate>${input.referencedInvoice.issueDate}</cbc:IssueDate>
      </cac:InvoiceDocumentReference>
   </cac:BillingReference>
   <cac:LegalMonetaryTotal>
      <cbc:LineExtensionAmount currencyID="${input.currency}">${money(subtotal)}</cbc:LineExtensionAmount>
      <cbc:TaxExclusiveAmount currencyID="${input.currency}">${money(subtotal)}</cbc:TaxExclusiveAmount>
      <cbc:TaxInclusiveAmount currencyID="${input.currency}">${money(taxInclusiveAmount)}</cbc:TaxInclusiveAmount>
      <cbc:PayableAmount currencyID="${input.currency}">${money(payableAmount)}</cbc:PayableAmount>
   </cac:LegalMonetaryTotal>${lineXml}
</CreditNote>`;

  return { xml, cude };
}
