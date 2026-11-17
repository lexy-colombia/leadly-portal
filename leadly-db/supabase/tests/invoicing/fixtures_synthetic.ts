/** Fixtures SINTÉTICOS (datos inventados, sin PII) que cubren las mismas rutas
 * fiscales que han roto en producción. Son la red de seguridad que corre sin
 * acceso a la base. Las facturas reales aceptadas (Barriles) van aparte, en
 * `progress/fixtures_private/*.json` (ignorado por git), con la misma forma. */
import type { CreditNoteFixture, InvoiceFixture, ItemRow, ProfileRow, SellerSnapshot } from "./harness.ts";

const r2 = (v: number) => Math.round(v * 100) / 100;

/** Línea de venta: `price` es el precio de LISTA con impuesto incluido; `discount` en %. */
function item(description: string, qty: number, price: number, code: string | null, rate: number, opts: { discount?: number; sku?: string | null; referencePrice?: number } = {}): ItemRow {
  const gross = r2(qty * price);
  const subtotal = r2(gross * (1 - (opts.discount ?? 0) / 100));
  const base = code ? r2(subtotal / (1 + rate / 100)) : subtotal;
  const tax = code ? r2(subtotal - base) : 0;
  return {
    description,
    sku: opts.sku ?? null,
    quantity: qty,
    unit_price: price,
    reference_unit_price: opts.referencePrice,
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

// Perfiles de facturación (autosuficientes). Persona natural con cédula.
const BUYER_PERSONA_NATURAL = {
  document_type_code: "13",
  document_number: "79123456",
  full_name: "MARIA PEREZ GOMEZ",
  email: "maria@example.invalid",
  applies_withholding: false,
  organization_type: "2" as const,
  tax_level_code: "R-99-PN",
  tax_scheme_code: "ZZ" as const,
  address: { line1: "Calle 10 # 20-30", city: "Bogotá D.C.", state_province: "Bogotá D.C.", country: "CO", city_code: "11001", state_code: "11" },
};
// Empresa con NIT (el DV 8 de 900123456 se valida en el test del perfil).
const BUYER_EMPRESA_NIT = {
  document_type_code: "31",
  document_number: "900123456",
  full_name: "EMPRESA DE PRUEBA S.A.S.",
  email: "facturas@empresa.example.invalid",
  applies_withholding: false,
  organization_type: "1" as const,
  tax_level_code: "O-13;O-23",
  tax_scheme_code: "01" as const,
  address: { line1: "Carrera 7 # 71-21", city: "Bogotá D.C.", state_province: "Bogotá D.C.", country: "CO", city_code: "11001", state_code: "11" },
};
// Extranjero: pasaporte, domicilio fuera de Colombia (sin DIVIPOLA).
const BUYER_EXTRANJERO = {
  document_type_code: "41",
  document_number: "X1234567",
  full_name: "JOHN DOE",
  email: "john@example.invalid",
  applies_withholding: false,
  organization_type: "2" as const,
  tax_level_code: "R-99-PN",
  tax_scheme_code: "ZZ" as const,
  address: { line1: "1 Main St", city: "Miami", state_province: "Florida", country: "US" },
};
// Consumidor Final con correo POR COMPROBANTE (walk-in sin perfil).
const BUYER_FINAL_CON_CORREO = {
  document_type_code: "13",
  document_number: "222222222222",
  full_name: "Consumidor final",
  email: "cliente.final@example.invalid",
  applies_withholding: false,
  organization_type: "2" as const,
  tax_level_code: "R-99-PN",
  tax_scheme_code: null,
  address: null,
};

// Lugar de entrega ya validado (buyer_snapshot.delivery): Medellín, DIVIPOLA 05001/05.
const DELIVERY_MEDELLIN = {
  line1: "Carrera 43A # 1-50, Torre 2 Apto 301",
  city: "Medellín",
  state_province: "Antioquia",
  country: "CO" as const,
  city_code: "05001",
  state_code: "05",
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

export { DELIVERY_MEDELLIN };
export const SYNTHETIC_INVOICES: InvoiceFixture[] = [
  // Restaurante: todo INC 8%, consumidor final sin dirección, hora diurna.
  inv("inc8-consumidor-final", {
    invoiceNumber: 101,
    issuedAtIso: "2026-09-10T18:30:15Z", // 13:30:15 Colombia
    buyer: BUYER_FINAL,
    items: [item("Bandeja paisa", 2, 38000, "04", 8, { sku: "BP-1" }), item("Limonada", 3, 9500, "04", 8), item("Postre", 1, 14000, "04", 8)],
  }),
  // Perfiles de facturación: persona natural, empresa NIT, extranjero y
  // Consumidor Final con correo del comprobante.
  inv("perfil-persona-natural", {
    invoiceNumber: 107,
    issuedAtIso: "2026-11-02T16:00:00Z",
    buyer: BUYER_PERSONA_NATURAL,
    items: [item("Producto", 2, 11900, "01", 19, { sku: "P-1" })],
  }),
  inv("perfil-empresa-nit", {
    invoiceNumber: 108,
    issuedAtIso: "2026-11-02T17:00:00Z",
    buyer: BUYER_EMPRESA_NIT,
    items: [item("Servicio", 1, 119000, "01", 19)],
  }),
  inv("perfil-extranjero", {
    invoiceNumber: 109,
    issuedAtIso: "2026-11-02T18:00:00Z",
    buyer: BUYER_EXTRANJERO,
    items: [item("Producto exportado", 1, 50000, null, 0)],
  }),
  inv("perfil-consumidor-final-correo", {
    invoiceNumber: 110,
    issuedAtIso: "2026-11-02T19:00:00Z",
    buyer: BUYER_FINAL_CON_CORREO,
    items: [item("Almuerzo", 1, 27000, "04", 8)],
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
    items: [item("Plato", 1, 27000, "04", 8), item("Huevo x sopa (gratis)", 1, 0, "04", 8, { referencePrice: 2160 }), item("Postre cortesía", 1, 8000, "04", 8, { discount: 100 })],
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

/** Fixtures de cac:Delivery: SOLO se ejercitan con el override explícito
 * `emitDelivery: true` (EMIT_DELIVERY_IN_XML está apagado: la factura no lleva
 * Delivery en el flujo por defecto). Sus snapshots viven aparte
 * (`delivery-override__*.xml`) y no forman parte de la paridad por defecto. */
export const DELIVERY_OVERRIDE_INVOICES: InvoiceFixture[] = [
  // cac:Delivery (Res. 227/2025 num. 3.2: adquirente SIN NIT en domicilio) y
  // opcional con NIT (3.1). Entre AccountingCustomerParty y PaymentMeans.
  inv("entrega-cedula-divipola", {
    invoiceNumber: 111,
    issuedAtIso: "2026-11-12T16:00:00Z",
    buyer: { ...BUYER_PERSONA_NATURAL, delivery: DELIVERY_MEDELLIN },
    items: [item("Producto a domicilio", 2, 11900, "01", 19, { sku: "P-2" })],
  }),
  inv("entrega-nit-divipola", {
    invoiceNumber: 112,
    issuedAtIso: "2026-11-12T17:00:00Z",
    buyer: { ...BUYER_EMPRESA_NIT, delivery: DELIVERY_MEDELLIN },
    items: [item("Servicio a domicilio", 1, 119000, "01", 19)],
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
