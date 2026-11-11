import { computeNitCheckDigit } from "./nit.ts";

type BuyerTaxSchemeCode = "01" | "04" | "ZA" | "ZZ";

export interface FiscalAddress {
  line1: string | null;
  line2?: string | null;
  country: string | null;
  city: string | null;
  state_province: string | null;
  city_code?: string | null;
  state_code?: string | null;
}

interface ClientBillingProfile {
  legal_name?: string | null;
  tax_level_code?: string | null;
  tax_scheme_code?: BuyerTaxSchemeCode | null;
  email?: string | null;
  address?: FiscalAddress | null;
}

interface FiscalClient {
  id: string;
  full_name: string;
  phone: string;
  email: string | null;
  document_number: string | null;
  dian_document_type_code: string | null;
  applies_withholding: boolean;
  is_walk_in: boolean;
  billing_profile?: ClientBillingProfile;
}

export const BUYER_TAX_SCHEMES: Record<BuyerTaxSchemeCode, string> = {
  "01": "IVA", "04": "INC", ZA: "IVA e INC", ZZ: "No aplica",
};

export function buildFiscalBuyer(client: FiscalClient | null) {
  const profile = client?.is_walk_in ? undefined : client?.billing_profile;
  const documentType = client?.dian_document_type_code ?? null;
  let documentNumber = client?.document_number?.trim() || null;
  const legalName = profile?.legal_name?.trim() || client?.full_name?.trim() || null;
  const address = profile?.address ?? null;
  const email = profile?.email?.trim() || client?.email?.trim() || null;
  const missing: string[] = [];

  if (!legalName) missing.push("nombre legal o razón social");
  if (!documentType) missing.push("tipo de documento del cliente");
  if (!documentNumber) missing.push("número de documento del cliente");
  if (documentType === "31" && documentNumber) {
    const nit = /^([0-9]{1,15})(?:-([0-9]))?$/.exec(documentNumber.replace(/[.\s]/g, ""));
    if (!nit) missing.push("NIT válido");
    else {
      documentNumber = nit[1];
      if (nit[2] && Number(nit[2]) !== computeNitCheckDigit(nit[1])) missing.push("dígito de verificación válido");
    }
  }
  if (!email) missing.push("correo de facturación");
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) missing.push("correo de facturación válido");
  if (address) {
    if (!address.line1?.trim()) missing.push("dirección fiscal");
    if (!address.country || !/^[A-Z]{2}$/.test(address.country) || address.country === "OT") missing.push("país de la dirección fiscal");
    if (address.country === "CO" && (!address.city_code || !address.state_code)) {
      missing.push("departamento y municipio de la dirección fiscal");
    }
  }

  return {
    missing,
    buyer: {
      client_id: client?.id ?? null,
      document_type_code: documentType,
      document_number: documentNumber,
      full_name: legalName,
      email,
      phone: client?.phone ?? null,
      applies_withholding: client?.applies_withholding ?? false,
      organization_type: documentType === "31" || documentType === "50" ? "1" as const : "2" as const,
      tax_level_code: profile?.tax_level_code ?? "R-99-PN",
      tax_scheme_code: profile?.tax_scheme_code ?? null,
      address,
    },
  };
}

export function countryName(code: string): string {
  return new Intl.DisplayNames(["es"], { type: "region" }).of(code) ?? code;
}
