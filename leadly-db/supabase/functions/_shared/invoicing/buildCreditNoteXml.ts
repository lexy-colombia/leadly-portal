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
  /** `null` cuando no hay dirección real -- ver buildInvoiceXml.ts para el
   * porqué (el grupo se omite entero, nunca se manda un placeholder). */
  addressLine: string | null;
  city: string | null;
  stateProvince: string | null;
  countryCode: string;
  /** Ver el mismo campo en buildInvoiceXml.ts::InvoiceXmlParty -- misma
   * regla (grupo de dirección con código DANE), corregido acá el
   * 2026-09-09 junto con la factura tras el primer rechazo real de la
   * DIAN sobre esa (no probado todavía puntualmente contra una nota
   * crédito, pero la estructura de AccountingSupplierParty/
   * AccountingCustomerParty es la misma en ambos documentos). */
  cityCode?: string | null;
  stateCode?: string | null;
  organizationType?: "1" | "2";
  taxLevelCode?: string;
  /** Ver buildInvoiceXml.ts::InvoiceXmlParty -- mismo grupo cac:Contact/
   * cbc:ElectronicMail del emisor (regla FAJ71), no probado todavía contra
   * una nota crédito real de producción pero misma estructura de Party. */
  electronicMail?: string | null;
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
  /** cac:PaymentMeans (CAN01: grupo OBLIGATORIO, 1..N -- faltaba por
   * completo, rechazo real 2026-09-10 "Rechazo si grupo no informado").
   * `meansId` "1" contado / "2" crédito (CAN02); `meansCode` es el medio
   * de pago del catálogo UNCL4461 (CAN03, obligatorio). Se arma con el
   * pago REAL de la venta que esta nota corrige, igual que la factura --
   * ver sendCreditNoteToDian.ts. Ojo CAN04: con `meansId` "2" la DIAN
   * exige además PaymentDueDate, por eso el caller nunca manda "2" sin
   * tenerla. */
  payment: { meansId: "1" | "2"; meansCode: string; dueDate?: string | null };
}

/** Descripción canónica por código de concepto de corrección
 * (`cac:DiscrepancyResponse/cbc:ResponseCode`). La regla CBF04 exige que
 * `cbc:Description` "corresponda al código informado en el elemento
 * anterior" -- se estaba mandando el texto libre que escribe el usuario en
 * el drawer, que por definición no está en la lista, de ahí la
 * notificación "La Descripción informada no se encuentra en la lista"
 * (rechazo real 2026-09-10). El texto que escribe el usuario NO se pierde:
 * sigue yendo en la descripción de la línea (`cac:Item/cbc:Description`),
 * que es texto libre legítimo.
 *
 * ⚠️ La tabla oficial (13.2.4) NO está en el PDF del Anexo Técnico -- vive
 * en un xlsx aparte de la "Caja de Herramientas" de la DIAN. Estas cadenas
 * son las mismas que ya muestra el selector del frontend
 * (`einvoicing.creditNote.reason.*`), así que XML y UI dicen lo mismo; los
 * textos de 5 y 6 conviene confirmarlos contra ese xlsx si la notificación
 * CBF04 persiste. */
const REASON_DESCRIPTION: Record<string, string> = {
  "1": "Devolución parcial de bienes o no aceptación parcial del servicio",
  "2": "Anulación de factura electrónica",
  "3": "Rebaja o descuento parcial o total",
  "4": "Ajuste de precio",
  "5": "Descuento",
  "6": "Otros",
};

function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Redondea, no trunca -- mismo motivo y misma corrección que
 * buildInvoiceXml.ts::money (la DIAN compara con round(), ver ese
 * comentario para el detalle). */
function money(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return rounded.toFixed(2);
}

function partyBlock(tag: "cac:AccountingSupplierParty" | "cac:AccountingCustomerParty", party: CreditNoteXmlParty, dv?: number): string {
  const companyIdAttrs = `schemeAgencyID="195" schemeAgencyName="CO, DIAN (Dirección de Impuestos y Aduanas Nacionales)"${
    dv !== undefined ? ` schemeID="${dv}"` : ""
  } schemeName="${esc(party.documentTypeCode)}"`;
  const organizationType = party.organizationType ?? (party.documentTypeCode === "31" ? "1" : "2");
  const taxLevelCode = party.taxLevelCode ?? "R-99-PN";
  const cityCodeXml = party.cityCode ? `\n               <cbc:ID>${esc(party.cityCode)}</cbc:ID>` : "";
  const stateCodeXml = party.stateCode ? `\n               <cbc:CountrySubentityCode>${esc(party.stateCode)}</cbc:CountrySubentityCode>` : "";
  // cac:PartyIdentification (reglas FAK61/FAK62/FAK63, ver el mismo fix en
  // buildInvoiceXml.ts) -- obligatorio en el comprador cuando es persona
  // natural.
  const partyIdentificationXml =
    tag === "cac:AccountingCustomerParty" && organizationType === "2"
      ? `
         <cac:PartyIdentification>
            <cbc:ID ${companyIdAttrs}>${esc(party.documentNumber)}</cbc:ID>
         </cac:PartyIdentification>`
      : "";
  // cac:Contact/cbc:ElectronicMail. En la factura esto solo aplica al
  // emisor (FAJ71), pero en la NOTA CRÉDITO la tabla de reglas lo pide
  // también para el comprador (CAK55, `/CreditNote/cac:AccountingCustomer
  // Party/cac:Party/cac:Contact/cbc:ElectronicMail`) -- rechazo real
  // reportado en vivo 2026-09-10 como "Correo electrónico no informado".
  // Por eso acá se emite para cualquiera de las dos partes que tenga
  // correo, no solo para el emisor. Se omite el grupo entero si el dato no
  // existe (un cliente de mostrador puede no tener correo cargado): mejor
  // la notificación blanda que un valor inventado.
  const contactXml =
    party.electronicMail
      ? `
         <cac:Contact>
            <cbc:ElectronicMail>${esc(party.electronicMail)}</cbc:ElectronicMail>
         </cac:Contact>`
      : "";
  // Grupos de dirección opcionales -- se omiten enteros sin dirección real
  // (ver buildInvoiceXml.ts::partyBlock para el porqué exacto).
  const hasAddress = Boolean(party.addressLine);
  const physicalLocationXml = !hasAddress
    ? ""
    : `
         <cac:PhysicalLocation>
            <cac:Address>${cityCodeXml}
               <cbc:CityName>${esc(party.city ?? "")}</cbc:CityName>
               <cbc:CountrySubentity>${esc(party.stateProvince ?? "")}</cbc:CountrySubentity>${stateCodeXml}
               <cac:AddressLine>
                  <cbc:Line>${esc(party.addressLine ?? "")}</cbc:Line>
               </cac:AddressLine>
               <cac:Country>
                  <cbc:IdentificationCode>${esc(party.countryCode)}</cbc:IdentificationCode>
                  <cbc:Name languageID="es">Colombia</cbc:Name>
               </cac:Country>
            </cac:Address>
         </cac:PhysicalLocation>`;
  const registrationAddressXml = !hasAddress
    ? ""
    : `
            <cac:RegistrationAddress>${cityCodeXml}
               <cbc:CityName>${esc(party.city ?? "")}</cbc:CityName>
               <cbc:CountrySubentity>${esc(party.stateProvince ?? "")}</cbc:CountrySubentity>${stateCodeXml}
               <cac:AddressLine>
                  <cbc:Line>${esc(party.addressLine ?? "")}</cbc:Line>
               </cac:AddressLine>
               <cac:Country>
                  <cbc:IdentificationCode>${esc(party.countryCode)}</cbc:IdentificationCode>
                  <cbc:Name languageID="es">Colombia</cbc:Name>
               </cac:Country>
            </cac:RegistrationAddress>`;
  return `
   <${tag}>
      <cbc:AdditionalAccountID>${organizationType}</cbc:AdditionalAccountID>
      <cac:Party>${partyIdentificationXml}
         <cac:PartyName>
            <cbc:Name>${esc(party.legalName)}</cbc:Name>
         </cac:PartyName>${physicalLocationXml}
         <cac:PartyTaxScheme>
            <cbc:RegistrationName>${esc(party.legalName)}</cbc:RegistrationName>
            <cbc:CompanyID ${companyIdAttrs}>${esc(party.documentNumber)}</cbc:CompanyID>
            <cbc:TaxLevelCode>${esc(taxLevelCode)}</cbc:TaxLevelCode>${registrationAddressXml}
            <cac:TaxScheme>
               <cbc:ID>01</cbc:ID>
               <cbc:Name>IVA</cbc:Name>
            </cac:TaxScheme>
         </cac:PartyTaxScheme>
         <cac:PartyLegalEntity>
            <cbc:RegistrationName>${esc(party.legalName)}</cbc:RegistrationName>
            <cbc:CompanyID ${companyIdAttrs}>${esc(party.documentNumber)}</cbc:CompanyID>
         </cac:PartyLegalEntity>${contactXml}
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

  // FAS01b (ver el mismo fix en buildInvoiceXml.ts): solo se emite un
  // cac:TaxTotal para el código de impuesto que la única línea de esta
  // nota crédito de verdad tiene -- antes se emitían los tres (IVA/INC/ICA)
  // siempre, incluidos dos en $0 sin ninguna línea que los respaldara, que
  // es exactamente lo que esa regla rechaza.
  const taxTotalBlocks = !tax
    ? ""
    : `
   <cac:TaxTotal>
      <cbc:TaxAmount currencyID="${input.currency}">${money(taxAmount)}</cbc:TaxAmount>
      <cac:TaxSubtotal>
         <cbc:TaxableAmount currencyID="${input.currency}">${money(tax.taxableAmount)}</cbc:TaxableAmount>
         <cbc:TaxAmount currencyID="${input.currency}">${money(taxAmount)}</cbc:TaxAmount>
         <cac:TaxCategory>
            <cbc:Percent>${tax.rate.toFixed(2)}</cbc:Percent>
            <cac:TaxScheme>
               <cbc:ID>${tax.code}</cbc:ID>
               <cbc:Name>${TAX_SCHEME_NAME[tax.code]}</cbc:Name>
            </cac:TaxScheme>
         </cac:TaxCategory>
      </cac:TaxSubtotal>
   </cac:TaxTotal>`;

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
   <cbc:LineCountNumeric>1</cbc:LineCountNumeric>
   <cac:DiscrepancyResponse>
      <cbc:ReferenceID>${esc(input.referencedInvoice.id)}</cbc:ReferenceID>
      <cbc:ResponseCode>${esc(input.reasonCode)}</cbc:ResponseCode>
      <cbc:Description>${esc(REASON_DESCRIPTION[input.reasonCode] ?? input.reasonDescription)}</cbc:Description>
   </cac:DiscrepancyResponse>
   <cac:BillingReference>
      <cac:InvoiceDocumentReference>
         <cbc:ID>${esc(input.referencedInvoice.id)}</cbc:ID>
         <cbc:UUID schemeName="CUFE-SHA384">${input.referencedInvoice.cufe}</cbc:UUID>
         <cbc:IssueDate>${input.referencedInvoice.issueDate}</cbc:IssueDate>
      </cac:InvoiceDocumentReference>
   </cac:BillingReference>${partyBlock("cac:AccountingSupplierParty", input.seller, sellerDv)}${partyBlock("cac:AccountingCustomerParty", input.buyer, buyerDv)}
   <cac:PaymentMeans>
      <cbc:ID>${input.payment.meansId}</cbc:ID>
      <cbc:PaymentMeansCode>${esc(input.payment.meansCode)}</cbc:PaymentMeansCode>${
        input.payment.meansId === "2" && input.payment.dueDate ? `\n      <cbc:PaymentDueDate>${esc(input.payment.dueDate)}</cbc:PaymentDueDate>` : ""
      }
   </cac:PaymentMeans>${taxTotalBlocks}
   <cac:LegalMonetaryTotal>
      <cbc:LineExtensionAmount currencyID="${input.currency}">${money(subtotal)}</cbc:LineExtensionAmount>
      <cbc:TaxExclusiveAmount currencyID="${input.currency}">${money(subtotal)}</cbc:TaxExclusiveAmount>
      <cbc:TaxInclusiveAmount currencyID="${input.currency}">${money(taxInclusiveAmount)}</cbc:TaxInclusiveAmount>
      <cbc:PayableAmount currencyID="${input.currency}">${money(payableAmount)}</cbc:PayableAmount>
   </cac:LegalMonetaryTotal>${lineXml}
</CreditNote>`;

  return { xml, cude };
}
