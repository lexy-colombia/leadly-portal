/** Fixtures SINTÉTICOS (datos inventados, sin PII) que cubren las mismas rutas
 * fiscales que han roto en producción. Son la red de seguridad que corre sin
 * acceso a la base. Las facturas reales aceptadas (Barriles) van aparte, en
 * `progress/fixtures_private/*.json` (ignorado por git), con la misma forma. */
import type { CreditNoteFixture, InvoiceFixture, ItemRow, ProfileRow, SellerSnapshot } from "./harness.ts";

const r2 = (v: number) => Math.round(v * 100) / 100;

/** Línea de venta: `price` es el precio de LISTA con impuesto incluido; `discount` en %. */
function item(description: string, qty: number, price: number, code: string | null, rate: number, opts: { discount?: number; sku?: string | null } = {}): ItemRow {
  const gross = r2(qty * price);
  const subtotal = r2(gross * (1 - (opts.discount ?? 0) / 100));
  const base = code ? r2(subtotal / (1 + rate / 100)) : subtotal;
  const tax = code ? r2(subtotal - base) : 0;
  return {
    description,
    sku: opts.sku ?? null,
    quantity: qty,
    unit_price: price,
    subtotal,
    tax_type_code: code,
    tax_rate: code ? rate : 0,
    tax_amount: tax,
    taxable_base: base,
  };
}

const SELLER: SellerSnapshot = {
  legal_name: "COMERCIAL DE PRUEBA S.A.S.",
  document_number: "900100200",
  city: "Bogotá D.C.",
  city_code: "11001",
  state_code: "11",
  billing_address: "Calle 1 # 2-3",
  country: "CO",
  state_province: "Bogotá D.C.",
  is_self_withholding_agent: false,
  contact_email: "facturacion@example.invalid",
};
const PROFILE: ProfileRow = {
  software_id: "00000000-0000-4000-8000-000000000000",
  resolution_number: "18760000000001",
  resolution_prefix: "FE",
  resolution_range_from: 1,
  resolution_range_to: 1000,
  resolution_valid_from: "2026-01-01",
  resolution_valid_until: "2027-12-31",
};
const SECRETS = { technicalKey: "0123456789abcdef0123456789abcdef01234567", softwarePin: "54321" };
const BUYER_NAMED = {
  document_type_code: "13",
  document_number: "1000000001",
  full_name: "COMPRADOR DE PRUEBA",
  email: "comprador@example.invalid",
  applies_withholding: false,
  address: { line1: "Carrera 4 # 5-6", city: "Medellín", state_province: "Antioquia", country: "CO", city_code: "05001", state_code: "05" },
};
const BUYER_FINAL = {
  document_type_code: "13",
  document_number: "222222222222",
  full_name: "Consumidor Final",
  applies_withholding: false,
  address: null,
};

function inv(label: string, overrides: Partial<InvoiceFixture> & Pick<InvoiceFixture, "items" | "issuedAtIso" | "invoiceNumber">): InvoiceFixture {
  return {
    kind: "invoice",
    label,
    isProduction: true,
    invoicePrefix: "FE",
    currency: "COP",
    buyer: BUYER_NAMED,
    seller: SELLER,
    profile: PROFILE,
    paymentMethod: "efectivo",
    storedCufe: null,
    secrets: SECRETS,
    synthetic: true,
    ...overrides,
  };
}

export const SYNTHETIC_INVOICES: InvoiceFixture[] = [
  // Restaurante: todo INC 8%, consumidor final sin dirección, hora diurna.
  inv("inc8-consumidor-final", {
    invoiceNumber: 101,
    issuedAtIso: "2026-09-10T18:30:15Z", // 13:30:15 Colombia
    buyer: BUYER_FINAL,
    items: [item("Bandeja paisa", 2, 38000, "04", 8, { sku: "BP-1" }), item("Limonada", 3, 9500, "04", 8), item("Postre", 1, 14000, "04", 8)],
  }),
  // Mixta IVA 19 + IVA 5 + línea sin impuesto (regresión FAU04 3ª ronda).
  inv("iva19-iva5-y-sin-impuesto", {
    invoiceNumber: 102,
    issuedAtIso: "2026-09-10T15:00:00Z",
    items: [item("Producto IVA 19", 4, 11900, "01", 19, { sku: "A" }), item("Producto IVA 5", 2, 10500, "01", 5), item("Servicio sin impuesto", 1, 17000, null, 0)],
  }),
  // FAW01: producto gratuito (unit_price 0) y línea 100% descontada.
  inv("faw01-gratis-y-descuento-100", {
    invoiceNumber: 103,
    issuedAtIso: "2026-09-29T17:00:00Z",
    items: [item("Plato", 1, 27000, "04", 8), item("Huevo x sopa (gratis)", 1, 0, "04", 8), item("Postre cortesía", 1, 8000, "04", 8, { discount: 100 })],
  }),
  // FAD06: suma con ruido de coma flotante (52777.78 + 17592.59 + 3703.70).
  inv("fad06-ruido-flotante", {
    invoiceNumber: 104,
    issuedAtIso: "2026-09-12T20:00:00Z",
    items: [
      { description: "L1", sku: null, quantity: 1, unit_price: 57000, subtotal: 57000, tax_type_code: "04", tax_rate: 8, tax_amount: 4222.22, taxable_base: 52777.78 },
      { description: "L2", sku: null, quantity: 1, unit_price: 19000, subtotal: 19000, tax_type_code: "04", tax_rate: 8, tax_amount: 1407.41, taxable_base: 17592.59 },
      { description: "L3", sku: null, quantity: 1, unit_price: 4000, subtotal: 4000, tax_type_code: "04", tax_rate: 8, tax_amount: 296.3, taxable_base: 3703.7 },
    ],
  }),
  // Noche (19:00-24:00 Colombia): UTC ya cruzó de día (FAD09e / issue date).
  inv("noche-cruza-dia-utc", {
    invoiceNumber: 105,
    issuedAtIso: "2026-09-11T02:30:00Z", // 21:30 del 10 en Colombia
    items: [item("Cena", 2, 54000, "04", 8)],
  }),
  // Habilitación (ambiente 2) + crédito (PaymentMeans 2), precios con decimales.
  inv("habilitacion-credito", {
    invoiceNumber: 106,
    isProduction: false,
    invoicePrefix: "SETP",
    issuedAtIso: "2026-09-09T14:45:30Z",
    paymentMethod: "credito",
    items: [item("Item decimal", 3, 3333.33, "01", 19), item("Item B", 7, 1234.5, "01", 0)],
  }),
];

export const SYNTHETIC_CREDIT_NOTES: CreditNoteFixture[] = [
  {
    kind: "credit_note",
    label: "nc-inc8",
    isProduction: true,
    issuedAtIso: "2026-09-10T20:15:00Z",
    creditNotePrefix: "NC",
    creditNoteNumber: 1,
    currency: "COP",
    buyer: BUYER_NAMED,
    seller: SELLER,
    reasonCode: "2",
    reasonDescription: "Anulación de factura electrónica",
    tax: { code: "04", rate: 8, subtotal: 115740.74, taxTotal: 9259.26, total: 125000 },
    referencedInvoice: { prefix: "FE", number: 101, cufe: "a".repeat(96), issueDateIso: "2026-09-10T18:30:15+00:00" },
    paymentMethod: "tarjeta",
    profile: { software_id: PROFILE.software_id },
    storedCude: null,
    secrets: SECRETS,
    synthetic: true,
  },
  {
    kind: "credit_note",
    label: "nc-sin-impuesto",
    isProduction: false,
    issuedAtIso: "2026-09-10T16:00:00Z",
    creditNotePrefix: "NC",
    creditNoteNumber: 2,
    currency: "COP",
    buyer: BUYER_FINAL,
    seller: SELLER,
    reasonCode: "1",
    reasonDescription: "Devolución parcial de bienes",
    tax: { code: null, rate: 0, subtotal: 17000, taxTotal: 0, total: 17000 },
    referencedInvoice: { prefix: "FE", number: 102, cufe: "b".repeat(96), issueDateIso: "2026-09-10T15:00:00+00:00" },
    paymentMethod: null,
    profile: { software_id: PROFILE.software_id },
    storedCude: null,
    secrets: SECRETS,
    synthetic: true,
  },
  // NC emitida de noche sobre factura de noche: la fecha referenciada debe ser
  // la de pared de Colombia de issue_date (BF1), no el slice UTC.
  {
    kind: "credit_note",
    label: "nc-referencia-factura-nocturna",
    isProduction: true,
    issuedAtIso: "2026-09-11T03:00:00Z",
    creditNotePrefix: "NC",
    creditNoteNumber: 3,
    currency: "COP",
    buyer: BUYER_NAMED,
    seller: SELLER,
    reasonCode: "2",
    reasonDescription: "Anulación de factura electrónica",
    tax: { code: "04", rate: 8, subtotal: 100000, taxTotal: 8000, total: 108000 },
    referencedInvoice: { prefix: "FE", number: 105, cufe: "c".repeat(96), issueDateIso: "2026-09-11T02:30:00+00:00" },
    paymentMethod: "efectivo",
    profile: { software_id: PROFILE.software_id },
    storedCude: null,
    secrets: SECRETS,
    synthetic: true,
  },
  // BF1: caso real FE371 (Barriles) -- issue_date 2026-10-09T03:17:18Z =
  // 2026-10-08 22:17 en Colombia; cbc:IssueDate declarado = 2026-10-08.
  {
    kind: "credit_note",
    label: "nc-referencia-fe371",
    isProduction: true,
    issuedAtIso: "2026-10-09T15:00:00Z",
    creditNotePrefix: "NC",
    creditNoteNumber: 4,
    currency: "COP",
    buyer: BUYER_NAMED,
    seller: SELLER,
    reasonCode: "2",
    reasonDescription: "Anulación de factura electrónica",
    tax: { code: "04", rate: 8, subtotal: 100000, taxTotal: 8000, total: 108000 },
    referencedInvoice: { prefix: "FE", number: 371, cufe: "d".repeat(96), issueDateIso: "2026-10-09T03:17:18+00:00" },
    paymentMethod: "efectivo",
    profile: { software_id: PROFILE.software_id },
    storedCude: null,
    secrets: SECRETS,
    synthetic: true,
  },
];
