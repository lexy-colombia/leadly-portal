/** Harness de paridad del motor DIAN (S0 de feature_invoicing_api).
 *
 * Solo LEE: nada acá escribe en DB, transmite a la DIAN ni usa el
 * certificado real. Reconstruye el input del núcleo (buildInvoiceXml /
 * buildCreditNoteXml / signInvoiceXml) desde FILAS de `sales_invoices` /
 * `sales_invoice_items` / `sales_credit_notes` / `tenant_dian_profile`, con el
 * MISMO mapeo que usan los orquestadores:
 *   - factura:      sendInvoiceToDian.ts   (mapeo en ~l.321-385)
 *   - nota crédito: sendCreditNoteToDian.ts (mapeo en ~l.195-248)
 * ⚠️ Esas dos funciones no exportan el mapeo, así que acá hay una COPIA. Si el
 * mapeo cambia allá y no acá, este harness deja de ser fiel (anotado en el
 * reporte; S2 debería extraer el mapeo a una función exportada).
 */
// PRIMER import, igual que en dian-submit/index.ts: el shim de `process`.
import "../../functions/_shared/invoicing/nodeCompatShim.ts";

import { DOMParser } from "npm:@xmldom/xmldom@0.8";
import { buildInvoiceXml, type BuildInvoiceXmlInput, type InvoiceXmlLine } from "../../functions/_shared/invoicing/buildInvoiceXml.ts";
import { buildCreditNoteXml, type BuildCreditNoteXmlInput } from "../../functions/_shared/invoicing/buildCreditNoteXml.ts";
import { colombiaIssueMoment } from "../../functions/_shared/invoicing/colombiaTime.ts";
import { buildCreditNoteXmlInput } from "../../functions/_shared/invoicing/creditNoteInput.ts";
import { findInvalidTaxRate } from "../../functions/_shared/invoicing/taxRates.ts";
import { parsePkcs12, type ParsedCertificate } from "../../functions/_shared/invoicing/certificate.ts";

// ---------------------------------------------------------------- fixtures

export interface BuyerSnapshot {
  client_id?: string | null;
  document_type_code: string | null;
  document_number: string | null;
  full_name: string | null;
  email?: string | null;
  applies_withholding: boolean;
  address: {
    line1: string | null;
    line2?: string | null;
    city: string | null;
    state_province: string | null;
    country: string | null;
    city_code?: string | null;
    state_code?: string | null;
  } | null;
}
export interface SellerSnapshot {
  legal_name: string | null;
  document_number: string | null;
  city: string | null;
  city_code?: string | null;
  state_code?: string | null;
  billing_address: string | null;
  country: string | null;
  state_province: string | null;
  is_self_withholding_agent?: boolean;
  contact_email?: string | null;
}
export interface ItemRow {
  description: string; // sales_invoice_items.product_name
  sku: string | null;
  quantity: number;
  unit_price: number;
  subtotal: number; // CON impuesto
  tax_type_code: string | null;
  tax_rate: number;
  tax_amount: number;
  taxable_base: number;
}
export interface ProfileRow {
  software_id: string;
  resolution_number: string | null;
  resolution_prefix: string;
  resolution_range_from: number;
  resolution_range_to: number | null;
  resolution_valid_from: string | null;
  resolution_valid_until: string | null;
}
export interface Secrets {
  /** Clave técnica del rango (Vault / GetNumberingRange). null = no disponible. */
  technicalKey: string | null;
  /** PIN del software (Vault). null = no disponible. */
  softwarePin: string | null;
}
export interface InvoiceFixture {
  kind: "invoice";
  label: string;
  /** true = integration_credentials.mode === "production". */
  isProduction: boolean;
  /** sales_invoices.issue_date (timestamptz ISO) -- es el `now` de envío. */
  issuedAtIso: string;
  invoicePrefix: string;
  invoiceNumber: number;
  currency: string;
  buyer: BuyerSnapshot;
  seller: SellerSnapshot;
  items: ItemRow[];
  profile: ProfileRow;
  /** sales_order_payments.method más reciente (null si no hay). */
  paymentMethod: string | null;
  /** sales_invoices.cufe guardado (null si no se conoce). */
  storedCufe: string | null;
  secrets: Secrets;
  /** true si los datos son sintéticos (se permite snapshot completo en git). */
  synthetic: boolean;
}
export interface CreditNoteFixture {
  kind: "credit_note";
  label: string;
  isProduction: boolean;
  issuedAtIso: string;
  creditNotePrefix: string;
  creditNoteNumber: number;
  currency: string;
  buyer: BuyerSnapshot;
  seller: SellerSnapshot;
  reasonCode: string;
  reasonDescription: string;
  /** sales_credit_notes.tax_type_code / tax_rate / subtotal / tax_total / total */
  tax: { code: string | null; rate: number; subtotal: number; taxTotal: number; total: number };
  /** Factura referenciada (sales_invoices de invoice_id). */
  referencedInvoice: { prefix: string; number: number; cufe: string; issueDateIso: string | null };
  paymentMethod: string | null;
  profile: { software_id: string };
  storedCude: string | null;
  secrets: Secrets;
  synthetic: boolean;
}
export type Fixture = InvoiceFixture | CreditNoteFixture;

// ------------------------------------------------- mapeo fila -> input (espejo)

const PAYMENT_MEANS_CODE: Record<string, string> = { efectivo: "10", transferencia: "42", wompi: "42", tarjeta: "48" };

export interface BuiltInvoiceInput {
  input: BuildInvoiceXmlInput;
  signingInstant: Date;
  /** Mensaje de FAX14 si la combinación tipo+tarifa no es válida (el orquestador aborta). */
  invalidRate: string | null;
}

export function invoiceFixtureToInput(fx: InvoiceFixture, technicalKeyOverride?: string, pinOverride?: string): BuiltInvoiceInput {
  const now = new Date(fx.issuedAtIso);
  const { issueDate, issueTime } = colombiaIssueMoment(now);
  const lines: InvoiceXmlLine[] = fx.items.map((item, idx) => ({
    id: idx + 1,
    description: String(item.description ?? "Producto"),
    sku: item.sku ? String(item.sku) : null,
    quantity: Number(item.quantity),
    unitPrice: Number(item.unit_price),
    lineExtensionAmount: Number(item.subtotal),
    tax: item.tax_type_code
      ? { code: String(item.tax_type_code), rate: Number(item.tax_rate), taxableAmount: Number(item.taxable_base), taxAmount: Number(item.tax_amount) }
      : null,
  }));
  const invalidRate = findInvalidTaxRate(lines);
  const { buyer, seller, profile } = fx;
  const input: BuildInvoiceXmlInput = {
    invoiceId: `${fx.invoicePrefix}${fx.invoiceNumber}`,
    issueDate,
    issueTime,
    currency: fx.currency ?? "COP",
    environment: fx.isProduction ? 1 : 2,
    seller: {
      legalName: seller.legal_name!,
      documentTypeCode: "31",
      documentNumber: seller.document_number!,
      addressLine: seller.billing_address ?? null,
      city: seller.city ?? null,
      stateProvince: seller.state_province ?? null,
      countryCode: seller.country ?? "CO",
      cityCode: seller.city_code ?? null,
      stateCode: seller.state_code ?? null,
      taxLevelCode: seller.is_self_withholding_agent ? "O-15" : "R-99-PN",
      electronicMail: seller.contact_email ?? null,
    },
    buyer: {
      legalName: buyer.full_name ?? "N/A",
      documentTypeCode: buyer.document_type_code!,
      documentNumber: buyer.document_number!,
      addressLine: buyer.address?.line1 ?? null,
      city: buyer.address?.city ?? null,
      stateProvince: buyer.address?.state_province ?? null,
      countryCode: buyer.address?.country ?? "CO",
      cityCode: buyer.address?.city_code ?? null,
      stateCode: buyer.address?.state_code ?? null,
      taxLevelCode: buyer.applies_withholding ? "O-15" : "R-99-PN",
    },
    lines,
    withholdings: [],
    resolution: {
      number: profile.resolution_number ?? "",
      prefix: profile.resolution_prefix,
      rangeFrom: String(profile.resolution_range_from),
      rangeTo: String(profile.resolution_range_to ?? profile.resolution_range_from),
      validFrom: profile.resolution_valid_from ?? issueDate,
      validUntil: profile.resolution_valid_until ?? issueDate,
    },
    softwareId: profile.software_id,
    softwarePin: pinOverride ?? fx.secrets.softwarePin ?? "",
    technicalKey: technicalKeyOverride ?? fx.secrets.technicalKey ?? "",
    authorizationProviderNit: "800197268",
    payment: {
      meansId: fx.paymentMethod === "credito" ? "2" : "1",
      meansCode: (fx.paymentMethod && PAYMENT_MEANS_CODE[fx.paymentMethod]) || "1",
    },
  };
  return { input, signingInstant: now, invalidRate };
}

export function creditNoteFixtureToInput(fx: CreditNoteFixture, pinOverride?: string): { input: BuildCreditNoteXmlInput; signingInstant: Date } {
  const now = new Date(fx.issuedAtIso);
  // MISMA función que ejecuta producción (sendCreditNoteToDian.ts) -- BF1:
  // el harness ya no duplica el mapeo.
  const input = buildCreditNoteXmlInput({
    creditNoteDocId: `${fx.creditNotePrefix}${fx.creditNoteNumber}`,
    now,
    isProduction: fx.isProduction,
    creditNote: {
      currency: fx.currency,
      reason_code: fx.reasonCode,
      reason_description: fx.reasonDescription,
      total: fx.tax.total,
      subtotal: fx.tax.subtotal,
      tax_total: fx.tax.taxTotal,
      tax_type_code: fx.tax.code,
      tax_rate: fx.tax.rate,
    },
    invoice: {
      invoice_prefix: fx.referencedInvoice.prefix,
      invoice_number: fx.referencedInvoice.number,
      cufe: fx.referencedInvoice.cufe,
      issue_date: fx.referencedInvoice.issueDateIso,
    },
    buyer: fx.buyer,
    seller: fx.seller,
    paymentMethod: fx.paymentMethod,
    softwareId: fx.profile.software_id,
    softwarePin: pinOverride ?? fx.secrets.softwarePin ?? "",
  });
  return { input, signingInstant: now };
}

// ----------------------------------------------------------- oráculo CUFE/CUDE

async function sha384Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-384", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
/** Truncado a 2 decimales sin depender de formatMonetary de cufe.ts. */
function money(v: number): string {
  const cents = Math.trunc(Math.round(v * 1e8) / 1e6); // limpia ruido flotante, luego trunca
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
export interface CufeSpecParts {
  numFac: string; fecFac: string; horFac: string; valFac: number;
  iva: number; inc: number; ica: number; valTot: number;
  nitOfe: string; numAdq: string; secret: string; env: 1 | 2;
}
/** Anexo Técnico v1.9, 11.2 -- escrito aparte de cufe.ts a propósito. */
export function specHash(p: CufeSpecParts): Promise<string> {
  return sha384Hex(
    p.numFac + p.fecFac + p.horFac + money(p.valFac) + "01" + money(p.iva) + "04" + money(p.inc) + "03" + money(p.ica) +
      money(p.valTot) + p.nitOfe + p.numAdq + p.secret + String(p.env),
  );
}

// ------------------------------------------------------------- XML helpers

export function parseXml(xml: string): Document {
  return new DOMParser().parseFromString(xml, "text/xml") as unknown as Document;
}
function textOf(el: Element | undefined | null): string {
  return (el?.textContent ?? "").trim();
}
function directChildren(el: Element, tag: string): Element[] {
  const out: Element[] = [];
  for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1 && (n as Element).tagName === tag) out.push(n as Element);
  return out;
}
function firstDesc(el: Element | Document, tag: string): Element | null {
  return (el as Element).getElementsByTagName(tag)[0] ?? null;
}
function num(el: Element | null): number {
  return Number(textOf(el));
}

export interface DocFacts {
  id: string;
  uuid: string;
  issueDate: string;
  issueTime: string;
  lineExtension: number;
  taxExclusive: number;
  taxInclusive: number;
  payable: number;
  lineSumExtension: number;
  lineSumTaxableByCode: Record<string, number>;
  headerTaxableByCode: Record<string, number>;
  headerTaxAmountByCode: Record<string, number>;
  headerTaxTotal: number;
  lineCount: number;
  lineCountNumeric: number | null;
  qrContainsUuid: boolean;
}

/** Extrae hechos numéricos/estructurales de una Invoice o CreditNote sin firmar. */
export function extractFacts(xml: string, kind: "invoice" | "credit_note"): DocFacts {
  const doc = parseXml(xml);
  const root = doc.documentElement;
  const lineTag = kind === "invoice" ? "cac:InvoiceLine" : "cac:CreditNoteLine";
  const lines = directChildren(root, lineTag);
  const lineSumTaxableByCode: Record<string, number> = {};
  let lineSumExtension = 0;
  for (const l of lines) {
    lineSumExtension += num(directChildren(l, "cbc:LineExtensionAmount")[0]);
    for (const tt of directChildren(l, "cac:TaxTotal")) {
      for (const st of directChildren(tt, "cac:TaxSubtotal")) {
        const code = textOf(firstDesc(st, "cbc:ID"));
        lineSumTaxableByCode[code] = (lineSumTaxableByCode[code] ?? 0) + num(directChildren(st, "cbc:TaxableAmount")[0]);
      }
    }
  }
  const headerTaxableByCode: Record<string, number> = {};
  const headerTaxAmountByCode: Record<string, number> = {};
  let headerTaxTotal = 0;
  for (const tt of directChildren(root, "cac:TaxTotal")) {
    const total = num(directChildren(tt, "cbc:TaxAmount")[0]);
    headerTaxTotal += total;
    for (const st of directChildren(tt, "cac:TaxSubtotal")) {
      const code = textOf(firstDesc(st, "cbc:ID"));
      headerTaxableByCode[code] = (headerTaxableByCode[code] ?? 0) + num(directChildren(st, "cbc:TaxableAmount")[0]);
      headerTaxAmountByCode[code] = (headerTaxAmountByCode[code] ?? 0) + num(directChildren(st, "cbc:TaxAmount")[0]);
    }
  }
  const lmt = directChildren(root, "cac:LegalMonetaryTotal")[0];
  const uuid = textOf(directChildren(root, "cbc:UUID")[0]);
  const qr = firstDesc(root, "sts:QRCode");
  const lcn = directChildren(root, "cbc:LineCountNumeric")[0];
  return {
    id: textOf(directChildren(root, "cbc:ID")[0]),
    uuid,
    issueDate: textOf(directChildren(root, "cbc:IssueDate")[0]),
    issueTime: textOf(directChildren(root, "cbc:IssueTime")[0]),
    lineExtension: num(directChildren(lmt, "cbc:LineExtensionAmount")[0]),
    taxExclusive: num(directChildren(lmt, "cbc:TaxExclusiveAmount")[0]),
    taxInclusive: num(directChildren(lmt, "cbc:TaxInclusiveAmount")[0]),
    payable: num(directChildren(lmt, "cbc:PayableAmount")[0]),
    lineSumExtension: Math.round(lineSumExtension * 100) / 100,
    lineSumTaxableByCode,
    headerTaxableByCode,
    headerTaxAmountByCode,
    headerTaxTotal: Math.round(headerTaxTotal * 100) / 100,
    lineCount: lines.length,
    lineCountNumeric: lcn ? Number(textOf(lcn)) : null,
    qrContainsUuid: qr ? textOf(qr).includes(uuid) : false,
  };
}

// ----------------------------------------------------------- certificado de prueba

/** Certificado AUTOFIRMADO descartable (node-forge) -> p12 -> parsePkcs12, el
 * mismo camino que el .p12 real. Nunca toca ni sustituye un certificado real. */
export async function makeSelfSignedCertificate(): Promise<ParsedCertificate> {
  const forge = (await import("npm:node-forge@1")).default;
  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date(Date.now() - 86_400_000);
  cert.validity.notAfter = new Date(Date.now() + 365 * 86_400_000);
  const attrs = [{ name: "commonName", value: "S0 PARITY HARNESS - SELF SIGNED - NOT A REAL CERTIFICATE" }, { name: "countryName", value: "CO" }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], "test-only", { algorithm: "3des" });
  const der = forge.asn1.toDer(p12Asn1).getBytes();
  const bytes = new Uint8Array(der.length);
  for (let i = 0; i < der.length; i++) bytes[i] = der.charCodeAt(i);
  return await parsePkcs12(bytes, "test-only");
}

export { buildInvoiceXml, buildCreditNoteXml };
