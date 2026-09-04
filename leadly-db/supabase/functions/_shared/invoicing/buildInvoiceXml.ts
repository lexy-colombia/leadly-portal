/** Construcción del XML UBL 2.1 de la Factura Electrónica de Venta --
 * Fase 2. Estructura basada en:
 * 1. El texto del Anexo Técnico v1.9 (Resolución 000165 de 2023) para los
 *    VALORES de cada código (CustomizationID, tipos de documento, tipos de
 *    impuesto).
 * 2. El XML de ejemplo oficial `Generica.xml` del kit de herramientas de la
 *    DIAN (mismo namespace/orden de elementos) para la ESTRUCTURA -- ver
 *    _shared/invoicing/dian-reference/ejemplos-xml/Generica.xml.
 *
 * ⚠️ Diferencia encontrada entre ambas fuentes: Generica.xml usa
 * CustomizationID="05", pero el texto vigente del Anexo (catálogo
 * TipoOperacionF-2.1.gc) dice que "10" es "Estándar" -- se sigue el texto
 * vigente (10), no el ejemplo, porque el ejemplo es un archivo de
 * demostración que puede no estar actualizado a la última versión del
 * catálogo.
 *
 * Deliberadamente NO incluye (quedan para cuando haya un caso real que lo
 * necesite, no se inventan ahora): AllowanceCharge, PrepaidPayment,
 * BillingReference, Delivery/DeliveryTerms, PaymentMeans detallado,
 * multi-moneda.
 *
 * Este archivo construye el XML SIN FIRMAR, pero ya deja un
 * `<ext:UBLExtension><ext:ExtensionContent/></ext:UBLExtension>` VACÍO como
 * segundo elemento de `ext:UBLExtensions` (mismo lugar exacto donde
 * Generica.xml pone su `ds:Signature` real) -- es a propósito: la firma
 * envolvente (enveloped-signature) calcula su hash sobre el documento tal
 * cual va a quedar al final, así que el hueco donde va la firma tiene que
 * existir ANTES de firmar, no agregarse después por fuera. Ver
 * signInvoiceXml.ts, que llena ese hueco.
 *
 * Antes de poder mandar esto a la DIAN todavía falta el envío por SOAP al
 * web service -- eso no está construido todavía. */

import { computeCufe, computeSoftwareSecurityCode } from "./cufe.ts";
import { computeNitCheckDigit } from "./nit.ts";

/** Códigos DIAN (tax_types.code) -> nombre exacto que exige el XML en
 * cac:TaxScheme/cbc:Name (ver Generica.xml: <cbc:Name>IVA</cbc:Name> etc). */
const TAX_SCHEME_NAME: Record<string, string> = { "01": "IVA", "03": "ICA", "04": "INC" };

/** dian_document_types.code -> schemeName que exige TipoIdFiscal-2.1.gc
 * (idéntico código, no hace falta traducir -- ambos catálogos usan los
 * mismos valores 11/12/13/21/22/31/41/42/50/91). */

export interface InvoiceXmlParty {
  legalName: string;
  documentTypeCode: string; // dian_document_types.code (ej. "31" = NIT)
  documentNumber: string; // sin puntos ni guiones, sin DV
  addressLine: string;
  city: string;
  stateProvince: string;
  countryCode: string; // ISO alpha-2, ej. "CO"
}

export interface InvoiceXmlLineTax {
  code: string; // "01" | "04" | "03"
  rate: number;
  taxableAmount: number;
  taxAmount: number;
}

export interface InvoiceXmlLine {
  id: number;
  description: string;
  quantity: number;
  unitPrice: number; // sin impuesto (BaseQuantity=1 implícito)
  lineExtensionAmount: number; // subtotal de la línea sin impuesto
  tax: InvoiceXmlLineTax | null;
}

export interface InvoiceXmlWithholding {
  code: "05" | "06" | "07";
  rate: number;
  base: number;
  amount: number;
}

export interface BuildInvoiceXmlInput {
  invoiceId: string; // prefijo + consecutivo, ej. "SETP990000001"
  issueDate: string; // YYYY-MM-DD
  issueTime: string; // HH:MM:SS-05:00
  currency: string; // ej. "COP"
  environment: 1 | 2; // 1 producción, 2 habilitación
  seller: InvoiceXmlParty;
  buyer: InvoiceXmlParty;
  lines: InvoiceXmlLine[];
  withholdings: InvoiceXmlWithholding[];
  resolution: {
    number: string;
    prefix: string;
    rangeFrom: string;
    rangeTo: string;
    validFrom: string; // YYYY-MM-DD
    validUntil: string; // YYYY-MM-DD
  };
  softwareId: string;
  softwarePin: string;
  technicalKey: string;
  authorizationProviderNit: string; // NIT de la DIAN como proveedor de autorización, fijo: "800197268"
}

function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function money(value: number): string {
  const truncated = Math.trunc(value * 100) / 100;
  return truncated.toFixed(2);
}

function partyBlock(tag: "cac:AccountingSupplierParty" | "cac:AccountingCustomerParty", party: InvoiceXmlParty, dv?: number): string {
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

export async function buildInvoiceXml(input: BuildInvoiceXmlInput): Promise<{ xml: string; cufe: string }> {
  const subtotal = input.lines.reduce((sum, l) => sum + l.lineExtensionAmount, 0);
  const taxByCode: Record<string, { taxable: number; amount: number; rate: number }> = {};
  for (const line of input.lines) {
    if (!line.tax || line.tax.taxAmount === 0) continue;
    const entry = taxByCode[line.tax.code] ?? { taxable: 0, amount: 0, rate: line.tax.rate };
    entry.taxable += line.tax.taxableAmount;
    entry.amount += line.tax.taxAmount;
    taxByCode[line.tax.code] = entry;
  }
  const ivaTotal = taxByCode["01"]?.amount ?? 0;
  const incTotal = taxByCode["04"]?.amount ?? 0;
  const icaTotal = taxByCode["03"]?.amount ?? 0;
  const taxTotal = ivaTotal + incTotal + icaTotal;
  const taxInclusiveAmount = subtotal + taxTotal;
  const withholdingTotal = input.withholdings.reduce((sum, w) => sum + w.amount, 0);
  // Nota DIAN (Anexo 11.9.1, observación 21/06/2019): la validación previa
  // NO resta las retenciones dentro de LegalMonetaryTotal -- PayableAmount
  // sigue siendo el total con impuestos, la retención es informativa /
  // afecta el pago real por fuera de este total.
  const payableAmount = taxInclusiveAmount;

  const sellerDv = computeNitCheckDigit(input.seller.documentNumber);
  const buyerDv = computeNitCheckDigit(input.buyer.documentNumber);

  const cufe = await computeCufe({
    numFac: input.invoiceId,
    fecFac: input.issueDate,
    horFac: input.issueTime,
    valFac: subtotal,
    valImp1Iva: ivaTotal,
    valImp2Inc: incTotal,
    valImp3Ica: icaTotal,
    valTot: taxInclusiveAmount,
    nitOfe: input.seller.documentNumber,
    numAdq: input.buyer.documentNumber,
    claveTecnica: input.technicalKey,
    tipoAmbiente: input.environment,
  });

  const softwareSecurityCode = await computeSoftwareSecurityCode(input.softwareId, input.softwarePin, input.invoiceId);

  const qrHost = input.environment === 1 ? "https://catalogo-vpfe.dian.gov.co" : "https://catalogo-vpfe-hab.dian.gov.co";
  const qrContent = [
    `NroFactura=${input.invoiceId}`,
    `NitFacturador=${input.seller.documentNumber}`,
    `NitAdquiriente=${input.buyer.documentNumber}`,
    `FechaFactura=${input.issueDate}`,
    `ValorTotalFactura=${money(payableAmount)}`,
    `CUFE=${cufe}`,
    `URL=${qrHost}/document/searchqr?documentkey=${cufe}`,
  ].join("\n");

  const taxTotalBlocks = (["01", "04", "03"] as const)
    .map((code) => {
      const entry = taxByCode[code] ?? { taxable: 0, amount: 0, rate: 0 };
      return `
   <cac:TaxTotal>
      <cbc:TaxAmount currencyID="${input.currency}">${money(entry.amount)}</cbc:TaxAmount>
      <cac:TaxSubtotal>
         <cbc:TaxableAmount currencyID="${input.currency}">${money(entry.taxable)}</cbc:TaxableAmount>
         <cbc:TaxAmount currencyID="${input.currency}">${money(entry.amount)}</cbc:TaxAmount>
         <cac:TaxCategory>
            <cbc:Percent>${entry.rate.toFixed(2)}</cbc:Percent>
            <cac:TaxScheme>
               <cbc:ID>${code}</cbc:ID>
               <cbc:Name>${TAX_SCHEME_NAME[code]}</cbc:Name>
            </cac:TaxScheme>
         </cac:TaxCategory>
      </cac:TaxSubtotal>
   </cac:TaxTotal>`;
    })
    .join("");

  const withholdingBlock =
    input.withholdings.length === 0
      ? ""
      : `
   <cac:WithholdingTaxTotal>
      <cbc:TaxAmount currencyID="${input.currency}">${money(withholdingTotal)}</cbc:TaxAmount>${input.withholdings
        .map(
          (w) => `
      <cac:TaxSubtotal>
         <cbc:TaxableAmount currencyID="${input.currency}">${money(w.base)}</cbc:TaxableAmount>
         <cbc:TaxAmount currencyID="${input.currency}">${money(w.amount)}</cbc:TaxAmount>
         <cac:TaxCategory>
            <cbc:Percent>${w.rate.toFixed(2)}</cbc:Percent>
            <cac:TaxScheme>
               <cbc:ID>${w.code}</cbc:ID>
               <cbc:Name>${TAX_SCHEME_NAME[w.code] ?? w.code}</cbc:Name>
            </cac:TaxScheme>
         </cac:TaxCategory>
      </cac:TaxSubtotal>`,
        )
        .join("")}
   </cac:WithholdingTaxTotal>`;

  const linesXml = input.lines
    .map((line) => {
      const lineTax = line.tax
        ? `
      <cac:TaxTotal>
         <cbc:TaxAmount currencyID="${input.currency}">${money(line.tax.taxAmount)}</cbc:TaxAmount>
         <cac:TaxSubtotal>
            <cbc:TaxableAmount currencyID="${input.currency}">${money(line.tax.taxableAmount)}</cbc:TaxableAmount>
            <cbc:TaxAmount currencyID="${input.currency}">${money(line.tax.taxAmount)}</cbc:TaxAmount>
            <cac:TaxCategory>
               <cbc:Percent>${line.tax.rate.toFixed(2)}</cbc:Percent>
               <cac:TaxScheme>
                  <cbc:ID>${line.tax.code}</cbc:ID>
                  <cbc:Name>${TAX_SCHEME_NAME[line.tax.code]}</cbc:Name>
               </cac:TaxScheme>
            </cac:TaxCategory>
         </cac:TaxSubtotal>
      </cac:TaxTotal>`
        : "";
      return `
   <cac:InvoiceLine>
      <cbc:ID>${line.id}</cbc:ID>
      <cbc:InvoicedQuantity unitCode="EA">${line.quantity.toFixed(6)}</cbc:InvoicedQuantity>
      <cbc:LineExtensionAmount currencyID="${input.currency}">${money(line.lineExtensionAmount)}</cbc:LineExtensionAmount>${lineTax}
      <cac:Item>
         <cbc:Description>${esc(line.description)}</cbc:Description>
      </cac:Item>
      <cac:Price>
         <cbc:PriceAmount currencyID="${input.currency}">${money(line.unitPrice)}</cbc:PriceAmount>
         <cbc:BaseQuantity unitCode="EA">1.000000</cbc:BaseQuantity>
      </cac:Price>
   </cac:InvoiceLine>`;
    })
    .join("");

  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="no"?><Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2" xmlns:sts="dian:gov:co:facturaelectronica:Structures-2-1" xmlns:xades="http://uri.etsi.org/01903/v1.3.2#" xmlns:xades141="http://uri.etsi.org/01903/v1.4.1#" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2     http://docs.oasis-open.org/ubl/os-UBL-2.1/xsd/maindoc/UBL-Invoice-2.1.xsd">
   <ext:UBLExtensions>
      <ext:UBLExtension>
         <ext:ExtensionContent>
            <sts:DianExtensions>
               <sts:InvoiceControl>
                  <sts:InvoiceAuthorization>${esc(input.resolution.number)}</sts:InvoiceAuthorization>
                  <sts:AuthorizationPeriod>
                     <cbc:StartDate>${input.resolution.validFrom}</cbc:StartDate>
                     <cbc:EndDate>${input.resolution.validUntil}</cbc:EndDate>
                  </sts:AuthorizationPeriod>
                  <sts:AuthorizedInvoices>
                     <sts:Prefix>${esc(input.resolution.prefix)}</sts:Prefix>
                     <sts:From>${esc(input.resolution.rangeFrom)}</sts:From>
                     <sts:To>${esc(input.resolution.rangeTo)}</sts:To>
                  </sts:AuthorizedInvoices>
               </sts:InvoiceControl>
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
   <cbc:CustomizationID>10</cbc:CustomizationID>
   <cbc:ProfileID>DIAN 2.1</cbc:ProfileID>
   <cbc:ProfileExecutionID>${input.environment}</cbc:ProfileExecutionID>
   <cbc:ID>${esc(input.invoiceId)}</cbc:ID>
   <cbc:UUID schemeID="2" schemeName="CUFE-SHA384">${cufe}</cbc:UUID>
   <cbc:IssueDate>${input.issueDate}</cbc:IssueDate>
   <cbc:IssueTime>${input.issueTime}</cbc:IssueTime>
   <cbc:InvoiceTypeCode>01</cbc:InvoiceTypeCode>
   <cbc:DocumentCurrencyCode listAgencyID="6" listAgencyName="United Nations Economic Commission for Europe" listID="ISO 4217 Alpha">${input.currency}</cbc:DocumentCurrencyCode>
   <cbc:LineCountNumeric>${input.lines.length}</cbc:LineCountNumeric>${partyBlock("cac:AccountingSupplierParty", input.seller, sellerDv)}${partyBlock("cac:AccountingCustomerParty", input.buyer, buyerDv)}${taxTotalBlocks}${withholdingBlock}
   <cac:LegalMonetaryTotal>
      <cbc:LineExtensionAmount currencyID="${input.currency}">${money(subtotal)}</cbc:LineExtensionAmount>
      <cbc:TaxExclusiveAmount currencyID="${input.currency}">${money(subtotal)}</cbc:TaxExclusiveAmount>
      <cbc:TaxInclusiveAmount currencyID="${input.currency}">${money(taxInclusiveAmount)}</cbc:TaxInclusiveAmount>
      <cbc:PayableAmount currencyID="${input.currency}">${money(payableAmount)}</cbc:PayableAmount>
   </cac:LegalMonetaryTotal>${linesXml}
</Invoice>`;

  return { xml, cufe };
}
