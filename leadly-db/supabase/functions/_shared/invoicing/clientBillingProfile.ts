import { computeNitCheckDigit } from "./nit.ts";

type BuyerTaxSchemeCode = "01" | "04" | "ZA" | "ZZ";

export interface FiscalAddress {
  line1: string | null;
  line2: string | null;
  country: string | null;
  city: string | null;
  state_province: string | null;
  city_code?: string | null;
  state_code?: string | null;
}

/** Fila de `client_billing_profiles` (solo las columnas fiscales). El perfil es
 * AUTOSUFICIENTE (decisión cerrada de la feature): todo lo que necesita el
 * adquirente de una factura sale de acá, NUNCA de `clients`. */
export interface BillingProfileRow {
  id: string;
  tenant_id?: string;
  client_id?: string;
  label?: string | null;
  is_default?: boolean;
  document_type_code: string | null;
  document_number: string | null;
  legal_name: string | null;
  email: string | null;
  phone: string | null;
  organization_type: "1" | "2" | null;
  tax_level_code: string | null;
  tax_scheme_code: BuyerTaxSchemeCode | null;
  applies_withholding: boolean | null;
  address_line1: string | null;
  address_line2?: string | null;
  country: string | null;
  state_code?: string | null;
  city_code?: string | null;
  state_province?: string | null;
  city?: string | null;
}

/** Columnas a pedir a PostgREST para armar un BillingProfileRow. */
export const BILLING_PROFILE_COLUMNS =
  "id, tenant_id, client_id, label, is_default, document_type_code, document_number, legal_name, email, phone, organization_type, tax_level_code, tax_scheme_code, applies_withholding, address_line1, address_line2, country, state_code, city_code, state_province, city";

/** Lo único que se lee de `clients` para el comprador: identidad del cliente
 * (no fiscal) y el flag de Consumidor Final. */
export interface FiscalClientRef {
  id: string;
  is_walk_in: boolean;
  /** Solo se usan para el Consumidor Final (excepción única, ver abajo). */
  full_name?: string | null;
  document_number?: string | null;
  dian_document_type_code?: string | null;
}

export const BUYER_TAX_SCHEMES: Record<BuyerTaxSchemeCode, string> = {
  "01": "IVA", "04": "INC", ZA: "IVA e INC", ZZ: "No aplica",
};

/** Documento oficial del Consumidor Final (Res. DIAN 227/2025, num. 3.3). */
export const CONSUMIDOR_FINAL_DOCUMENT = { type: "13", number: "222222222222", name: "Consumidor final" } as const;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** ¿El perfil trae algún dato de domicilio fiscal? (misma regla que el SQL de
 * apply_sales_order_confirmed_effects: line1 / country / city.) */
function hasAddress(p: BillingProfileRow): boolean {
  return !!(p.address_line1?.trim() || p.country || p.city?.trim());
}

export function profileAddress(p: BillingProfileRow): FiscalAddress | null {
  if (!hasAddress(p)) return null;
  return {
    line1: p.address_line1,
    line2: p.address_line2 ?? null,
    country: p.country,
    city: p.city ?? null,
    state_province: p.state_province ?? null,
    city_code: p.city_code ?? null,
    state_code: p.state_code ?? null,
  };
}

/** ÚNICA lista de faltantes de un perfil de facturación. La usan buildFiscalBuyer
 * (al emitir) y fulfillmentAndBilling.ts (al elegir el perfil en cualquier
 * canal), así un perfil incompleto produce exactamente los mismos faltantes en
 * todos lados. `documentNumber` normalizado (sin DV) se devuelve aparte. */
export function billingProfileMissing(p: BillingProfileRow, email: string | null = p.email?.trim() || null): { missing: string[]; documentNumber: string | null } {
  const missing: string[] = [];
  let documentNumber = p.document_number?.trim() || null;
  if (!p.legal_name?.trim()) missing.push("nombre legal o razón social");
  if (!p.document_type_code) missing.push("tipo de documento del cliente");
  if (!documentNumber) missing.push("número de documento del cliente");
  if (p.document_type_code === "31" && documentNumber) {
    const nit = /^([0-9]{1,15})(?:-([0-9]))?$/.exec(documentNumber.replace(/[.\s]/g, ""));
    if (!nit) missing.push("NIT válido");
    else {
      documentNumber = nit[1];
      if (nit[2] && Number(nit[2]) !== computeNitCheckDigit(nit[1])) missing.push("dígito de verificación válido");
    }
  }
  if (!email) missing.push("correo de facturación");
  else if (!EMAIL_RE.test(email)) missing.push("correo de facturación válido");
  if (!p.tax_level_code) missing.push("responsabilidad tributaria");
  const address = profileAddress(p);
  if (address) {
    if (!address.line1?.trim()) missing.push("dirección fiscal");
    if (!address.country || !/^[A-Z]{2}$/.test(address.country) || address.country === "OT") missing.push("país de la dirección fiscal");
    if (address.country === "CO" && (!address.city_code || !address.state_code)) {
      missing.push("departamento y municipio de la dirección fiscal");
    }
  }
  return { missing, documentNumber };
}

export interface BuildFiscalBuyerInput {
  client: FiscalClientRef | null;
  /** Perfil elegido (el del pedido o el predeterminado del cliente). */
  profile: BillingProfileRow | null;
  /** Correo del COMPROBANTE, OPCIONAL, solo para Consumidor Final sin perfil: se congela
   * únicamente en el buyer_snapshot de esa factura, nunca en la ficha del
   * walk-in (compartida por todas las ventas de mostrador). */
  invoiceEmail?: string | null;
}

/** Arma el comprador (adquirente) del snapshot de factura.
 *
 * Sin respaldo desde `clients`: si falta algo del perfil, bloquea con la lista.
 * Única excepción: Consumidor Final (walk-in) SIN perfil, que usa el documento
 * oficial 222222222222 y exige el correo del comprobante. */
export function buildFiscalBuyer(input: BuildFiscalBuyerInput) {
  const { client, profile } = input;

  // Consumidor Final (walk-in): su comprador sale SOLO de su identidad
  // (222222222222) + el correo del comprobante. Ignora is_default y cualquier
  // perfil (la base tampoco admite perfiles bajo un walk-in): de lo contrario
  // un perfil de un tercero facturaría las ventas de mostrador a ese tercero.
  if (client?.is_walk_in) {
    // El correo del Consumidor Final es OPCIONAL (Anexo Técnico 1.9, FAK55:
    // "Para consumidor final el elemento ElectronicMail es opcional"): sin
    // invoice_email la factura sale sin cac:Contact del adquirente y NO se
    // bloquea. Si se manda uno, debe tener formato válido.
    const email = input.invoiceEmail?.trim() || null;
    const missing: string[] = [];
    if (email && !EMAIL_RE.test(email)) missing.push("correo de facturación válido");
    const documentType = client.dian_document_type_code && client.document_number ? client.dian_document_type_code : CONSUMIDOR_FINAL_DOCUMENT.type;
    const documentNumber = client.dian_document_type_code && client.document_number ? client.document_number : CONSUMIDOR_FINAL_DOCUMENT.number;
    return {
      missing,
      buyer: {
        client_id: client.id,
        billing_profile_id: null as string | null,
        document_type_code: documentType as string | null,
        document_number: documentNumber as string | null,
        full_name: (client.full_name?.trim() || CONSUMIDOR_FINAL_DOCUMENT.name) as string | null,
        email,
        // De dónde vino el correo: solo un correo capturado para ESTE
        // comprobante (invoice_email) se puede reutilizar en un reintento.
        email_source: (email ? "invoice_email" : null) as string | null,
        phone: null as string | null,
        applies_withholding: false,
        organization_type: "2" as "1" | "2",
        tax_level_code: "R-99-PN" as string | null,
        tax_scheme_code: null as BuyerTaxSchemeCode | null,
        address: null as FiscalAddress | null,
      },
    };
  }

  if (!profile) {
    return {
      missing: ["perfil de facturación"],
      buyer: {
        client_id: client?.id ?? null,
        billing_profile_id: null as string | null,
        document_type_code: null as string | null,
        document_number: null as string | null,
        full_name: null as string | null,
        email: null as string | null,
        email_source: null as string | null,
        phone: null as string | null,
        applies_withholding: false,
        organization_type: "2" as "1" | "2",
        tax_level_code: null as string | null,
        tax_scheme_code: null as BuyerTaxSchemeCode | null,
        address: null as FiscalAddress | null,
      },
    };
  }

  const email = profile.email?.trim() || null;
  const { missing, documentNumber } = billingProfileMissing(profile, email);
  const documentType = profile.document_type_code;
  return {
    missing,
    buyer: {
      client_id: client?.id ?? profile.client_id ?? null,
      billing_profile_id: profile.id as string | null,
      document_type_code: documentType,
      document_number: documentNumber,
      full_name: profile.legal_name?.trim() || null,
      email,
      email_source: (email ? "billing_profile" : null) as string | null,
      phone: profile.phone?.trim() || null,
      applies_withholding: profile.applies_withholding ?? false,
      organization_type: (profile.organization_type ?? (documentType === "31" || documentType === "50" ? "1" : "2")) as "1" | "2",
      tax_level_code: profile.tax_level_code,
      tax_scheme_code: profile.tax_scheme_code,
      address: profileAddress(profile),
    },
  };
}

export function countryName(code: string): string {
  return new Intl.DisplayNames(["es"], { type: "region" }).of(code) ?? code;
}

// deno-lint-ignore no-explicit-any
type AdminClient = any;

/** Selecciona el perfil de un pedido: el elegido (`billingProfileId`) o, si es
 * null, el predeterminado del cliente (transición). Siempre acotado a tenant y
 * cliente dueño. Devuelve `chosenMissing = true` si el pedido apunta a un perfil
 * que ya no existe / está borrado / no es del cliente (no se cae al
 * predeterminado en silencio). */
export async function loadBillingProfileForOrder(
  adminClient: AdminClient,
  tenantId: string,
  contactId: string,
  billingProfileId: string | null,
  isWalkIn = false,
): Promise<{ profile: BillingProfileRow | null; chosenMissing: boolean }> {
  // El Consumidor Final no usa perfiles (ni el predeterminado ni uno elegido).
  if (isWalkIn) return { profile: null, chosenMissing: false };
  if (billingProfileId) {
    const { data, error } = await adminClient
      .from("client_billing_profiles")
      .select(BILLING_PROFILE_COLUMNS)
      .eq("id", billingProfileId)
      .eq("tenant_id", tenantId)
      .eq("client_id", contactId)
      .is("deleted_at", null)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return { profile: (data as BillingProfileRow | null) ?? null, chosenMissing: !data };
  }
  const { data, error } = await adminClient
    .from("client_billing_profiles")
    .select(BILLING_PROFILE_COLUMNS)
    .eq("tenant_id", tenantId)
    .eq("client_id", contactId)
    .eq("is_default", true)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return { profile: (data as BillingProfileRow | null) ?? null, chosenMissing: false };
}
