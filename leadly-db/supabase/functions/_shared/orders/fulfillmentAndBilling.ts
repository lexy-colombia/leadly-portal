/** Reglas ÚNICAS de "cómo se entrega" y "a quién se factura" un pedido o
 * carrito, para TODOS los canales (calculate-order, create-order,
 * pos-checkout, storefront, y la facturación misma).
 *
 * Qué resuelve (feature direcciones de entrega + perfiles de facturación):
 *  - `fulfillment_method`: 'delivery' exige un destino con dirección (y, para
 *    Colombia, municipio+departamento DANE cuando `requireDane`); 'pickup' y
 *    'on_site' NO piden destino.
 *  - Pertenencia: la dirección de envío y el perfil de facturación tienen que
 *    ser del mismo tenant Y del mismo cliente dueño del pedido. La base lo
 *    garantiza también (FK compuesta del perfil + trigger
 *    enforce_order_cart_links para la dirección), pero acá se verifica ANTES
 *    con el admin client para devolver un error claro y no un 23503 crudo.
 *  - Si se pide factura, la lista de faltantes del perfil es la MISMA función
 *    que usa `buildFiscalBuyer` al emitir (clientBillingProfile.ts): un perfil
 *    incompleto produce los mismos faltantes en todos los canales.
 *
 * La parte pura (`evaluateFulfillmentAndBilling`) no hace I/O y está probada en
 * tests/orders. `resolveFulfillmentAndBilling` solo carga filas y la llama. */
import {
  BILLING_PROFILE_COLUMNS,
  buildFiscalBuyer,
  loadBillingProfileForOrder,
  type BillingProfileRow,
  type FiscalClientRef,
} from "../invoicing/clientBillingProfile.ts";

export const FULFILLMENT_METHODS = ["delivery", "pickup", "on_site"] as const;
export type FulfillmentMethod = (typeof FULFILLMENT_METHODS)[number];

export function isFulfillmentMethod(value: unknown): value is FulfillmentMethod {
  return typeof value === "string" && (FULFILLMENT_METHODS as readonly string[]).includes(value);
}

/** ¿Se exige municipio+departamento DANE en un destino de Colombia?
 *
 * Es `false` a propósito MIENTRAS el frontend (S5) no capture el código DANE en
 * el formulario de dirección: encenderlo antes dejaría sin poder confirmar
 * ningún domicilio de Colombia (las direcciones existentes no lo traen). La
 * regla (Res. DIAN 227/2025 num. 3.2/3.3 + Anexo 1.9) sí está implementada y
 * probada con `requireDane: true`; cuando S5 esté publicado se cambia SOLO esta
 * constante. La emisión (S3/S4) aplica su propia regla fiscal al armar
 * `cac:Delivery`. */
export const REQUIRE_DANE_FOR_DELIVERY = false;

/** Fila de `contact_addresses` (solo lo que esta lógica necesita). */
export interface DestinationAddress {
  id: string;
  tenant_id: string;
  contact_id: string | null;
  recipient_name?: string | null;
  phone?: string | null;
  line1: string | null;
  line2?: string | null;
  city?: string | null;
  state_province?: string | null;
  postal_code?: string | null;
  country?: string | null;
  city_code?: string | null;
  state_code?: string | null;
  notes?: string | null;
}

export const DESTINATION_COLUMNS =
  "id, tenant_id, contact_id, recipient_name, phone, line1, line2, city, state_province, postal_code, country, city_code, state_code, notes";

/** Mismo patrón que `guard_sales_order_confirmation` (SQL, `\yna\y`): un texto
 * de relleno no es una dirección. (La versión en confirmSalesOrder.ts quedó
 * alineada con esta.) */
export const PLACEHOLDER_RE = /no registrad|sin direcci[oó]n|pendiente|desconocid|por definir|n\/a|\bna\b/i;

export function isColombia(country: string | null | undefined): boolean {
  const c = (country ?? "").trim().toLowerCase();
  return c === "" || c === "co" || c === "colombia";
}

/** Destino de UN SOLO USO ("Usar en este pedido"): no está en la libreta del
 * cliente. Se guarda como `shipping_snapshot` con `shipping_address_id = null`.
 * Pasa por las MISMAS reglas que una dirección guardada (línea 1 real, no
 * relleno, y DANE cuando REQUIRE_DANE_FOR_DELIVERY se active). */
export interface ShippingDestinationInput {
  recipient_name?: string | null;
  phone?: string | null;
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  state_province?: string | null;
  state_code?: string | null;
  city_code?: string | null;
  postal_code?: string | null;
  notes?: string | null;
  country?: string | null;
}

const DESTINATION_KEYS = ["recipient_name", "phone", "line1", "line2", "city", "state_province", "state_code", "city_code", "postal_code", "notes", "country"] as const;

/** Normaliza lo que llega del body: solo las claves conocidas, strings con trim
 * (vacío -> null). Devuelve null si no es un objeto. */
export function normalizeShippingDestination(raw: unknown): ShippingDestinationInput | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Record<string, string | null> = {};
  for (const k of DESTINATION_KEYS) {
    const v = (raw as Record<string, unknown>)[k];
    out[k] = typeof v === "string" && v.trim() !== "" ? v.trim() : null;
  }
  return out as ShippingDestinationInput;
}

/** shipping_snapshot de un destino puntual (misma forma que el del guard, con
 * `address_id: null` y `one_off: true`). */
export function buildOneOffSnapshot(d: ShippingDestinationInput, now: Date = new Date()): Record<string, unknown> {
  return {
    address_id: null,
    recipient_name: d.recipient_name ?? null,
    phone: d.phone ?? null,
    line1: d.line1 ?? null,
    line2: d.line2 ?? null,
    city: d.city ?? null,
    state_province: d.state_province ?? null,
    country: d.country ?? null,
    postal_code: d.postal_code ?? null,
    city_code: d.city_code ?? null,
    state_code: d.state_code ?? null,
    notes: d.notes ?? null,
    one_off: true,
    frozen_at: now.toISOString(),
  };
}

export interface EvaluateInput {
  tenantId: string;
  /** Cliente dueño del pedido/carrito (`contact_id`). */
  contactId: string | null;
  fulfillmentMethod: FulfillmentMethod;
  /** Id de dirección pedido por el llamador (aunque no se haya encontrado). */
  shippingAddressIdGiven?: string | null;
  /** Fila cargada: la del id dado, o (opcional) la predeterminada del cliente. */
  shippingAddress?: DestinationAddress | null;
  /** Destino de un solo uso (excluyente con `shippingAddressIdGiven`). */
  shippingDestination?: ShippingDestinationInput | null;
  billingProfileIdGiven?: string | null;
  billingProfile?: BillingProfileRow | null;
  invoiceRequested?: boolean;
  client?: FiscalClientRef | null;
  /** Correo del comprobante (Consumidor Final sin perfil). */
  invoiceEmail?: string | null;
  requireDane?: boolean;
}

export interface EvaluateResult {
  ok: boolean;
  /** Datos que faltan (accionables, en español): destino + facturación. */
  missing: string[];
  /** Subconjunto de `missing` que corresponde al destino de entrega. */
  missingDestination: string[];
  /** Subconjunto de `missing` que corresponde al perfil de facturación. */
  missingBilling: string[];
  /** Violaciones de pertenencia (tenant/cliente). Nunca se corrigen solas. */
  forbidden: string[];
  normalized: {
    fulfillment_method: FulfillmentMethod;
    shipping_address_id: string | null;
    billing_profile_id: string | null;
    /** Snapshot del destino puntual (null si no hay). */
    shipping_snapshot: Record<string, unknown> | null;
  };
}

export function evaluateFulfillmentAndBilling(input: EvaluateInput): EvaluateResult {
  const missingDestination: string[] = [];
  const missingBilling: string[] = [];
  const forbidden: string[] = [];
  const addr = input.shippingAddress ?? null;
  const profile = input.billingProfile ?? null;

  // --- Pertenencia de la dirección (siempre que venga una) ---
  if (input.shippingAddressIdGiven && !addr) {
    forbidden.push("La dirección de envío no existe o no pertenece a este tenant.");
  } else if (addr && input.shippingAddressIdGiven) {
    if (addr.tenant_id !== input.tenantId) forbidden.push("La dirección de envío no pertenece a este tenant.");
    else if (!input.contactId) forbidden.push("La dirección de envío necesita un cliente en el pedido.");
    else if (addr.contact_id !== input.contactId) forbidden.push("La dirección de envío no pertenece al cliente del pedido.");
  }

  // --- Pertenencia del perfil (siempre que venga uno) ---
  if (input.billingProfileIdGiven && !profile) {
    forbidden.push("El perfil de facturación no existe o no pertenece a este tenant.");
  } else if (profile && input.billingProfileIdGiven) {
    if (profile.tenant_id !== input.tenantId) forbidden.push("El perfil de facturación no pertenece a este tenant.");
    else if (!input.contactId) forbidden.push("El perfil de facturación necesita un cliente en el pedido.");
    else if (profile.client_id !== input.contactId) forbidden.push("El perfil de facturación no pertenece al cliente del pedido.");
  }

  // --- Destino: una dirección guardada O un destino puntual, no ambos ---
  const dest = input.shippingDestination ?? null;
  if (dest && input.shippingAddressIdGiven) {
    forbidden.push("Elige una dirección guardada o un destino puntual, no ambos.");
  }
  if (dest && !input.shippingAddressIdGiven) {
    // Mismas reglas que una dirección guardada, también fuera de 'delivery' (un
    // destino puntual sin dirección no se guarda a medias).
    const l1 = dest.line1?.trim() ?? "";
    if (l1 === "" || PLACEHOLDER_RE.test(l1)) {
      missingDestination.push("dirección de entrega");
    } else if (input.fulfillmentMethod === "delivery" && input.requireDane && isColombia(dest.country) && (!dest.city_code || !dest.state_code)) {
      missingDestination.push("municipio y departamento (DANE) de la dirección de entrega");
    }
  } else if (input.fulfillmentMethod === "delivery") {
    const line1 = addr?.line1?.trim() ?? "";
    if (!addr || line1 === "" || PLACEHOLDER_RE.test(line1)) {
      missingDestination.push("dirección de entrega");
    } else if (input.requireDane && isColombia(addr.country) && (!addr.city_code || !addr.state_code)) {
      missingDestination.push("municipio y departamento (DANE) de la dirección de entrega");
    }
  }

  // --- Facturación: misma lista de faltantes que buildFiscalBuyer ---
  if (input.invoiceRequested && forbidden.length === 0) {
    const { missing: buyerMissing } = buildFiscalBuyer({
      client: input.client ?? null,
      profile,
      invoiceEmail: input.invoiceEmail ?? null,
    });
    missingBilling.push(...buyerMissing);
  }

  const missing = [...missingDestination, ...missingBilling];
  return {
    ok: missing.length === 0 && forbidden.length === 0,
    missing,
    missingDestination,
    missingBilling,
    forbidden,
    normalized: {
      fulfillment_method: input.fulfillmentMethod,
      shipping_address_id: addr && input.shippingAddressIdGiven && forbidden.length === 0 ? addr.id : null,
      billing_profile_id: profile && input.billingProfileIdGiven && forbidden.length === 0 ? profile.id : null,
      shipping_snapshot: dest && !input.shippingAddressIdGiven && forbidden.length === 0 ? buildOneOffSnapshot(dest) : null,
    },
  };
}

// deno-lint-ignore no-explicit-any
type AdminClient = any;

export interface ResolveArgs {
  tenantId: string;
  contactId: string | null;
  fulfillmentMethod: FulfillmentMethod;
  shippingAddressId?: string | null;
  /** Destino de un solo uso (excluyente con `shippingAddressId`). */
  shippingDestination?: ShippingDestinationInput | null;
  billingProfileId?: string | null;
  invoiceRequested?: boolean;
  invoiceEmail?: string | null;
  requireDane?: boolean;
  /** Si no hay `shippingAddressId` y el método es 'delivery', usar la
   * dirección de envío predeterminada del cliente (igual que el guard SQL al
   * confirmar). Solo para validar: NO se escribe en el pedido. */
  useDefaultDestination?: boolean;
}

/** Carga las filas con el admin client (siempre acotadas por tenant) y evalúa. */
export async function resolveFulfillmentAndBilling(adminClient: AdminClient, args: ResolveArgs): Promise<EvaluateResult> {
  let shippingAddress: DestinationAddress | null = null;
  if (args.shippingAddressId) {
    const { data, error } = await adminClient
      .from("contact_addresses")
      .select(DESTINATION_COLUMNS)
      .eq("id", args.shippingAddressId)
      .eq("tenant_id", args.tenantId)
      .is("deleted_at", null)
      .maybeSingle();
    if (error) throw new Error(error.message);
    shippingAddress = (data as DestinationAddress | null) ?? null;
  } else if (!args.shippingDestination && args.useDefaultDestination && args.fulfillmentMethod === "delivery" && args.contactId) {
    const { data, error } = await adminClient
      .from("contact_addresses")
      .select(DESTINATION_COLUMNS)
      .eq("tenant_id", args.tenantId)
      .eq("contact_id", args.contactId)
      .eq("is_shipping", true)
      .is("deleted_at", null)
      .not("line1", "is", null)
      .order("is_default", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(5);
    if (error) throw new Error(error.message);
    shippingAddress = ((data ?? []) as DestinationAddress[]).find((a) => a.line1 && !PLACEHOLDER_RE.test(a.line1)) ?? null;
  }

  let client: FiscalClientRef | null = null;
  if (args.contactId && (args.invoiceRequested || args.billingProfileId)) {
    const { data, error } = await adminClient
      .from("clients")
      .select("id, full_name, document_number, dian_document_type_code, is_walk_in")
      .eq("id", args.contactId)
      .eq("tenant_id", args.tenantId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    client = (data as FiscalClientRef | null) ?? null;
  }
  const walkIn = !!client?.is_walk_in;

  let billingProfile: BillingProfileRow | null = null;
  if (args.billingProfileId) {
    const { data, error } = await adminClient
      .from("client_billing_profiles")
      .select(BILLING_PROFILE_COLUMNS)
      .eq("id", args.billingProfileId)
      .eq("tenant_id", args.tenantId)
      .is("deleted_at", null)
      .maybeSingle();
    if (error) throw new Error(error.message);
    billingProfile = (data as BillingProfileRow | null) ?? null;
  } else if (args.invoiceRequested && args.contactId) {
    // Transición: sin perfil elegido, el predeterminado del cliente (nunca para
    // el Consumidor Final).
    billingProfile = (await loadBillingProfileForOrder(adminClient, args.tenantId, args.contactId, null, walkIn)).profile;
  }

  return evaluateFulfillmentAndBilling({
    tenantId: args.tenantId,
    contactId: args.contactId,
    fulfillmentMethod: args.fulfillmentMethod,
    shippingAddressIdGiven: args.shippingAddressId ?? null,
    shippingAddress,
    shippingDestination: args.shippingDestination ?? null,
    billingProfileIdGiven: args.billingProfileId ?? null,
    billingProfile,
    invoiceRequested: args.invoiceRequested,
    client,
    invoiceEmail: args.invoiceEmail ?? null,
    requireDane: args.requireDane,
  });
}

/** Destino congelado (misma forma que escribe `guard_sales_order_confirmation`
 * en `sales_orders.shipping_snapshot`). Lo usa la corrección de destino de un
 * pedido ya confirmado. */
export function buildShippingSnapshot(a: DestinationAddress, now: Date = new Date()): Record<string, unknown> {
  return {
    address_id: a.id,
    recipient_name: a.recipient_name ?? null,
    phone: a.phone ?? null,
    line1: a.line1,
    line2: a.line2 ?? null,
    city: a.city ?? null,
    state_province: a.state_province ?? null,
    country: a.country ?? null,
    postal_code: a.postal_code ?? null,
    city_code: a.city_code ?? null,
    state_code: a.state_code ?? null,
    notes: a.notes ?? null,
    frozen_at: now.toISOString(),
  };
}

/** Traduce los errores de pertenencia que lanza la base (23503) a un mensaje
 * claro. Devuelve null si el error no es de este tipo. */
export function describeOrderLinkError(error: { code?: string; message?: string } | null | undefined): { status: number; message: string } | null {
  if (!error || error.code !== "23503") return null;
  const msg = error.message ?? "";
  if (msg.includes("SHIPPING_ADDRESS_OWNER") || msg.includes("shipping_address_owner")) {
    return { status: 409, message: "La dirección de envío no pertenece al cliente del pedido." };
  }
  if (msg.includes("billing_profile_fkey")) {
    return { status: 409, message: "El perfil de facturación no pertenece al cliente del pedido." };
  }
  return null;
}

/** Código estable (409) cuando un reintento por `checkout_token` pide un
 * "Facturar a" distinto al que quedó fijado en el pedido ya creado. */
export const BILLING_PROFILE_MISMATCH_CODE = "billing_profile_mismatch";
export const BILLING_PROFILE_MISMATCH_MESSAGE =
  'Este cobro ya creó el pedido con otro perfil de facturación. Reintenta con el mismo "Facturar a" o inicia un cobro nuevo.';

/** `requested` undefined = el llamador no mandó el campo (no se compara). */
export function billingProfileMismatch(requested: string | null | undefined, saved: string | null | undefined): boolean {
  return requested !== undefined && (requested ?? null) !== (saved ?? null);
}
