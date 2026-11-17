/** Mapeo PURO buyer_snapshot -> comprador del XML de una FACTURA. Extraído de
 * sendInvoiceToDian.ts para que producción y el harness de paridad
 * (tests/invoicing) ejecuten EXACTAMENTE el mismo código (antes el harness
 * tenía una copia a mano que no pasaba organizationType / taxSchemeCode /
 * electronicMail). El equivalente de la nota crédito es creditNoteInput.ts. */
import type { InvoiceXmlDelivery, InvoiceXmlParty } from "./buildInvoiceXml.ts";
import { EMIT_DELIVERY_IN_XML, sanitizeAddressLine, type InvoiceDeliverySnapshot } from "./invoiceDelivery.ts";

export interface InvoiceBuyerSnapshot {
  document_type_code: string | null;
  document_number: string | null;
  full_name: string | null;
  applies_withholding?: boolean;
  email?: string | null;
  organization_type?: "1" | "2" | null;
  tax_level_code?: string | null;
  tax_scheme_code?: "01" | "04" | "ZA" | "ZZ" | null;
  address: {
    line1: string | null;
    line2?: string | null;
    city: string | null;
    state_province: string | null;
    country: string | null;
    city_code?: string | null;
    state_code?: string | null;
  } | null;
  /** Destino de entrega ya validado al armar el snapshot (invoiceDelivery.ts).
   * Ausente en facturas anteriores a esta función: sin Delivery. */
  delivery?: InvoiceDeliverySnapshot | null;
}

export function mapInvoiceBuyer(buyer: InvoiceBuyerSnapshot): InvoiceXmlParty {
  return {
    legalName: buyer.full_name ?? "N/A",
    documentTypeCode: buyer.document_type_code!,
    documentNumber: buyer.document_number!,
    addressLine: buyer.address?.line1 ?? null,
    city: buyer.address?.city ?? null,
    stateProvince: buyer.address?.state_province ?? null,
    countryCode: buyer.address?.country ?? "CO",
    cityCode: buyer.address?.city_code ?? null,
    stateCode: buyer.address?.state_code ?? null,
    organizationType: buyer.organization_type ?? undefined,
    taxLevelCode: buyer.tax_level_code ?? (buyer.applies_withholding ? "O-15" : "R-99-PN"),
    taxSchemeCode: buyer.tax_scheme_code ?? undefined,
    electronicMail: buyer.email ?? null,
  };
}

/** Mapeo PURO buyer_snapshot.delivery -> `cac:Delivery` de la factura. Misma
 * función en producción (sendInvoiceToDian) y en el harness de paridad.
 *
 * Defensa en profundidad: aunque el snapshot ya se validó al armarlo, acá se
 * vuelve a exigir lo que el Anexo 1.9 rechaza si falta (FAM05/08 DIVIPOLA,
 * FAM10 línea, FAM12 país) y se OMITE el grupo entero si algo no está. Nunca
 * emite un Delivery a medias. */
export function mapInvoiceDelivery(buyer: Pick<InvoiceBuyerSnapshot, "delivery">, emit: boolean = EMIT_DELIVERY_IN_XML): InvoiceXmlDelivery | null {
  // Interruptor general: con EMIT_DELIVERY_IN_XML=false se ignora incluso un
  // delivery ya guardado en el snapshot de una factura anterior.
  if (!emit) return null;
  const d = buyer.delivery;
  if (!d) return null;
  const line = sanitizeAddressLine(d.line1 ?? "");
  const cityCode = d.city_code?.trim();
  const stateCode = d.state_code?.trim();
  if (!line || !cityCode || !stateCode || d.country !== "CO") return null;
  if (!/^\d{5}$/.test(cityCode) || !/^\d{2}$/.test(stateCode) || !cityCode.startsWith(stateCode)) return null;
  return {
    addressLine: line,
    city: d.city,
    stateProvince: d.state_province,
    cityCode,
    stateCode,
    countryCode: d.country,
  };
}
