/** Mapeo PURO fila -> BuildCreditNoteXmlInput de una nota crédito (sin I/O,
 * sin cliente de Supabase). Extraído de sendCreditNoteToDian.ts (BF1,
 * 2026-10-09) para que producción y el harness de paridad
 * (tests/invoicing) ejecuten EXACTAMENTE el mismo código: antes el harness
 * tenía una copia a mano y una regresión en producción no rompía ningún test. */
import type { BuildCreditNoteXmlInput } from "./buildCreditNoteXml.ts";
import { colombiaDateOfInstant, colombiaIssueMoment } from "./colombiaTime.ts";

export interface CreditNoteBuyerSnapshot {
  document_type_code: string | null;
  document_number: string | null;
  full_name: string | null;
  applies_withholding?: boolean;
  /** Correo del cliente -- ya viene en el snapshot desde
   * queueInvoiceGeneration.ts. Lo exige la regla CAK55 de la NOTA CRÉDITO
   * (en la factura el correo obligatorio es el del emisor, FAJ71; acá es
   * también el del comprador). */
  email?: string | null;
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
export interface CreditNoteSellerSnapshot {
  legal_name: string | null;
  document_number: string | null;
  city: string | null;
  city_code?: string | null;
  state_code?: string | null;
  billing_address: string | null;
  country: string | null;
  state_province: string | null;
  is_self_withholding_agent?: boolean;
  /** Ver buildInvoiceXml.ts (regla FAJ71) -- copiado tal cual del
   * seller_snapshot de la factura referenciada. */
  contact_email?: string | null;
}

// cac:PaymentMeans (CAN01) -- catálogo UNCL4461; ver el comentario en
// sendCreditNoteToDian.ts sobre por qué siempre es "1" (contado).
const PAYMENT_MEANS_CODE: Record<string, string> = {
  efectivo: "10",
  transferencia: "42",
  wompi: "42",
  tarjeta: "48",
};

export interface CreditNoteInputParams {
  creditNoteDocId: string;
  now: Date;
  isProduction: boolean;
  creditNote: {
    currency: string | null;
    reason_code: string;
    reason_description: string;
    total: number;
    subtotal: number;
    tax_total: number;
    tax_type_code: string | null;
    tax_rate: number;
  };
  invoice: { invoice_prefix: string; invoice_number: number | string; cufe: string; issue_date: string | Date | null };
  buyer: CreditNoteBuyerSnapshot;
  seller: CreditNoteSellerSnapshot;
  paymentMethod: string | null;
  softwareId: string;
  softwarePin: string;
}

export function buildCreditNoteXmlInput(p: CreditNoteInputParams): BuildCreditNoteXmlInput {
  const { creditNote, invoice, buyer, seller, paymentMethod } = p;
  // Hora REAL de Colombia -- ver colombiaTime.ts.
  const { issueDate, issueTime } = colombiaIssueMoment(p.now);
  return {
    creditNoteId: p.creditNoteDocId,
    issueDate,
    issueTime,
    currency: creditNote.currency ?? "COP",
    environment: p.isProduction ? 1 : 2,
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
      electronicMail: buyer.email ?? null,
    },
    referencedInvoice: {
      id: `${invoice.invoice_prefix}${invoice.invoice_number}`,
      cufe: invoice.cufe,
      // BF1 (2026-10-09): la fecha que la factura declaró ante la DIAN es la
      // de PARED de Colombia del instante `issue_date` (sendInvoiceToDian.ts
      // arma cbc:IssueDate con colombiaIssueMoment(now) y guarda ese mismo
      // `now` como issue_date). Un slice(0, 10) del timestamptz da la fecha
      // UTC, un día posterior para facturas emitidas 19:00-23:59 hora CO.
      issueDate: colombiaDateOfInstant(invoice.issue_date) ?? issueDate,
    },
    reasonCode: creditNote.reason_code,
    reasonDescription: creditNote.reason_description,
    line: {
      description: `Ajuste según nota crédito -- ${creditNote.reason_description}`,
      amount: creditNote.total,
      tax: creditNote.tax_type_code
        ? { code: creditNote.tax_type_code, rate: creditNote.tax_rate, taxableAmount: creditNote.subtotal, taxAmount: creditNote.tax_total }
        : null,
    },
    payment: {
      meansId: "1",
      meansCode: (paymentMethod && PAYMENT_MEANS_CODE[paymentMethod]) || "1",
    },
    softwareId: p.softwareId,
    softwarePin: p.softwarePin,
    authorizationProviderNit: "800197268",
  };
}
