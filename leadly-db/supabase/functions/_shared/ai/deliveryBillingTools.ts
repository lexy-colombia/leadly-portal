/** Lógica PURA (sin I/O) de las herramientas de IA de entrega y facturación
 * (feature direcciones de entrega + perfiles de facturación, S4).
 *
 * Vive acá y no en whatsapp-ai-tools/index.ts porque ese archivo arranca un
 * servidor al importarse; así se puede probar (tests/ai_billing) y también la
 * usa whatsapp-ai-respond para el contexto del cliente.
 *
 * Dos flujos SEPARADOS:
 *  - ENTREGA: direcciones (`contact_addresses`, solo envío). Se confirman con el
 *    cliente, nunca se asignan solas. Solo se exigen si el pedido es de entrega.
 *  - FACTURACIÓN: perfiles (`client_billing_profiles`). Solo se tocan cuando el
 *    cliente PIDE factura. La lista de faltantes es la misma que usa la emisión
 *    (`billingProfileMissing`, clientBillingProfile.ts). */
import { billingProfileMissing, type BillingProfileRow } from "../invoicing/clientBillingProfile.ts";
import { isPlaceholderAddressText } from "../orders/confirmSalesOrder.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** "1", "opción 2", 3 -> número. null si no trae dígitos. */
export function parseOptionNumber(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const digits = String(value).replace(/\D/g, "");
  return digits ? Number(digits) : null;
}

export type ReferenceResolution =
  | { kind: "none" }
  | { kind: "id"; id: string }
  | { kind: "option"; id: string }
  | { kind: "unmatched"; raw: string };

/** Referencia que manda el modelo a una dirección/perfil guardado: el id real
 * (UUID) tal cual, o el número de opción (`option`) con el que se le listó al
 * cliente, resuelto contra la MISMA lista, en el mismo orden, que recibió el
 * modelo. Un UUID se devuelve tal cual: la pertenencia (tenant + cliente) la
 * verifica quien lo usa, nunca se confía en él. */
export function resolveReference(items: { option: number; id: string }[], value: unknown): ReferenceResolution {
  if (value === undefined || value === null || String(value).trim() === "") return { kind: "none" };
  const raw = String(value).trim();
  if (UUID_RE.test(raw)) return { kind: "id", id: raw };
  const option = parseOptionNumber(raw);
  const match = option !== null ? items.find((i) => i.option === option) : undefined;
  return match ? { kind: "option", id: match.id } : { kind: "unmatched", raw };
}

// ---------------------------------------------------------------- ENTREGA

export interface DeliveryAddressRow {
  id: string;
  line1: string | null;
  line2: string | null;
  city: string | null;
}

export interface SavedAddress {
  option: number;
  address_id: string;
  address: string;
}

const normalizeKey = (value: string | null) => (value ?? "").toLowerCase().normalize("NFD").replace(/[^a-z0-9ñ]/g, "");

/** Direcciones de ENTREGA en texto, sin repetidas, con `option` (1, 2, 3).
 * "carrera 26 # 2i 24, Neiva" y "Carrera 26 # 2i 24 Neiva" son la misma
 * dirección para el cliente: se lista una vez, sin repetir la ciudad si ya viene
 * en la línea. Se omiten los textos de relleno. Máximo 3 (el orden de entrada es
 * el de preferencia: predeterminada primero). */
export function buildSavedAddresses(rows: DeliveryAddressRow[]): SavedAddress[] {
  const byKey = new Map<string, { address_id: string; address: string }>();
  for (const row of rows) {
    if (!row.line1 || isPlaceholderAddressText(row.line1)) continue;
    const street = [row.line1, row.line2].filter(Boolean).join(" ");
    const city = normalizeKey(row.city);
    const streetKey = normalizeKey(street);
    const key = city && streetKey.endsWith(city) ? streetKey.slice(0, -city.length) : streetKey;
    if (byKey.has(key)) continue;
    if (byKey.size === 3) continue;
    byKey.set(key, {
      address_id: row.id,
      address: row.city && !(city && streetKey.endsWith(city)) ? `${street}, ${row.city}` : street,
    });
  }
  return [...byKey.values()].map((entry, index) => ({ option: index + 1, address_id: entry.address_id, address: entry.address }));
}

export function unmatchedAddressMessage(raw: string, addresses: SavedAddress[]): string {
  const choices = addresses.map((a) => `${a.option}) ${a.address} [address_id ${a.address_id}]`).join("; ") || "ninguna";
  return `"${raw}" no corresponde a ninguna dirección guardada. Opciones: ${choices}. Vuelve a llamar esta herramienta con una de ellas en este mismo turno, sin preguntarle de nuevo al cliente.`;
}

// ------------------------------------------------------------ FACTURACIÓN

/** Documento enmascarado: nunca se le muestra completo a la IA ni al contexto. */
export function maskDocument(value: string | null | undefined): string {
  const digits = (value ?? "").trim();
  if (!digits) return "sin documento";
  return digits.length <= 4 ? "****" : `****${digits.slice(-3)}`;
}

/** Tipo de documento que dice el cliente -> código DIAN (`document_types`). */
const DOCUMENT_TYPE_CODES: Record<string, string> = {
  CC: "13", NIT: "31", CE: "22", PASAPORTE: "41", TI: "12", RC: "11", PEP: "47", PPT: "48", NUIP: "91",
  "NIT_EXTRANJERO": "50", "DOCUMENTO_EXTRANJERO": "42", "TARJETA_EXTRANJERIA": "21",
};
export const DOCUMENT_TYPE_LABELS = Object.keys(DOCUMENT_TYPE_CODES);

export function mapDocumentTypeToDian(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const key = value.trim().toUpperCase().replace(/\s+/g, "_");
  if (DOCUMENT_TYPE_CODES[key]) return DOCUMENT_TYPE_CODES[key];
  // También acepta el código DIAN directo ("13", "31").
  return Object.values(DOCUMENT_TYPE_CODES).includes(key) ? key : null;
}

const DOCUMENT_CODE_LABEL: Record<string, string> = Object.fromEntries(
  [["13", "CC"], ["31", "NIT"], ["22", "CE"], ["41", "Pasaporte"], ["12", "TI"], ["11", "RC"], ["47", "PEP"], ["48", "PPT"], ["91", "NUIP"], ["50", "NIT extranjero"], ["42", "Doc. extranjero"], ["21", "Tarjeta de extranjería"]],
);

/** País que dijo el cliente -> código ISO-2. Vacío = Colombia. null = no se
 * pudo resolver sin consultar el catálogo (el llamador lo busca por nombre). */
export function toIsoCountry(value: unknown): string | null {
  const v = String(value ?? "").trim();
  if (!v || v.toLowerCase() === "colombia") return "CO";
  return /^[A-Za-z]{2}$/.test(v) ? v.toUpperCase() : null;
}

export interface CityRow { code: string; name: string; department_code: string }
export interface DepartmentRow { code: string; name: string }

export function normalizePlace(value: string | null | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9ñ ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const PLACE_STOPWORDS = new Set(["de", "del", "la", "las", "los", "el", "y"]);

/** Tokens significativos de un lugar: sin tildes/mayúsculas/puntuación, sin
 * conectores ("de", "del", ...) ni letras sueltas ("D.C." -> nada). */
export function placeTokens(value: string | null | undefined): string[] {
  return normalizePlace(value).split(" ").filter((t) => t.length > 1 && !PLACE_STOPWORDS.has(t));
}

/** Tokens del nombre BASE (antes de la coma) del catálogo: "Bogotá, D.C." -> [bogota]. */
function baseTokens(name: string): string[] {
  return placeTokens(name.split(",")[0]);
}

const isSubset = (small: string[], big: string[]) => small.length > 0 && small.every((t) => big.includes(t));
const sameTokens = (a: string[], b: string[]) => a.length === b.length && isSubset(a, b);

export type DivipolaResolution =
  | { kind: "resolved"; state_code: string; city_code: string }
  | { kind: "ambiguous"; options: string[] }
  | { kind: "not_found" };

/** Municipio (y opcionalmente departamento) que dijo el cliente -> pareja
 * DIVIPOLA, sobre el catálogo COMPLETO (nunca truncado).
 *
 * Emparejamiento por tokens normalizados, en dos niveles:
 *  1. Nombre igual (mismos tokens que el nombre base del catálogo): "Medellín",
 *     "Bogotá D.C." = "Bogotá, D.C.".
 *  2. Si no hay ninguno, los tokens del cliente CONTENIDOS en los del catálogo:
 *     "Cali" -> "Santiago de Cali", "Cúcuta" -> "San José de Cúcuta",
 *     "Cartagena" -> "Cartagena de Indias" / "Cartagena del Chairá".
 * Luego, si el cliente dio departamento ("Valle", o "Cali, Valle del Cauca"),
 * se filtra por él. Solo en el nivel 2 y con varios candidatos, si exactamente
 * uno es capital departamental (código DIVIPOLA terminado en 001) se prefiere
 * esa (el uso corriente de "Cartagena" es la capital). En cualquier otro caso
 * con más de un candidato NO adivina: devuelve los departamentos para que la IA
 * pregunte. Orden determinista (por código). */
export function resolveDivipola(
  cities: CityRow[],
  departments: DepartmentRow[],
  city: string,
  stateProvince?: string | null,
): DivipolaResolution {
  const [cityPart, ...rest] = city.split(",");
  const wanted = placeTokens(cityPart);
  if (wanted.length === 0) return { kind: "not_found" };
  // "Cali, Valle" también aporta el departamento si no vino aparte.
  const stateText = stateProvince && stateProvince.trim() ? stateProvince : rest.join(" ");
  const sorted = [...cities].sort((x, y) => (x.code < y.code ? -1 : x.code > y.code ? 1 : 0));

  const exact = sorted.filter((c) => sameTokens(baseTokens(c.name), wanted));
  const partial = exact.length > 0 ? [] : sorted.filter((c) => isSubset(wanted, baseTokens(c.name)));
  let matches = exact.length > 0 ? exact : partial;
  const partialTier = exact.length === 0;

  if (matches.length > 1) {
    const dept = placeTokens(stateText);
    if (dept.length > 0) {
      // Departamento con el mismo nombre primero ("Cauca" no es "Valle del Cauca").
      const sameDept = departments.filter((d) => sameTokens(dept, placeTokens(d.name)));
      const deptCodes = (sameDept.length > 0 ? sameDept : departments.filter((d) => isSubset(dept, placeTokens(d.name)))).map((d) => d.code);
      const narrowed = matches.filter((c) => deptCodes.includes(c.department_code));
      if (narrowed.length > 0) matches = narrowed;
    }
  }
  if (matches.length > 1 && partialTier) {
    const capitals = matches.filter((c) => c.code === `${c.department_code}001`);
    if (capitals.length === 1) matches = capitals;
  }
  if (matches.length === 0) return { kind: "not_found" };
  if (matches.length > 1) {
    const names = matches.map((m) => departments.find((d) => d.code === m.department_code)?.name ?? m.department_code);
    return { kind: "ambiguous", options: [...new Set(names)] };
  }
  return { kind: "resolved", state_code: matches[0].department_code, city_code: matches[0].code };
}

/** Parámetros de una herramienta de facturación SIN datos sensibles, para
 * guardarlos en ai_tool_executions: documento y teléfono enmascarados, correo
 * enmascarado. El resto (alias, tipo, ciudad, flags) se conserva. */
export const BILLING_TOOL_NAMES = new Set(["list_billing_profiles", "select_billing_profile", "save_billing_profile"]);
export function redactBillingParameters(functionName: string, parameters: Record<string, unknown>): Record<string, unknown> {
  if (!BILLING_TOOL_NAMES.has(functionName)) return parameters;
  const out: Record<string, unknown> = { ...parameters };
  if (out.document_number != null) out.document_number = maskDocument(String(out.document_number));
  if (out.phone != null) out.phone = maskDocument(String(out.phone));
  if (typeof out.email === "string") {
    const at = out.email.indexOf("@");
    out.email = at > 0 ? `${out.email[0]}***${out.email.slice(at)}` : "***";
  }
  for (const k of ["address_line1", "address_line2"]) if (out[k] != null) out[k] = "[omitido]";
  return out;
}

export interface BillingProfileInput {
  label?: string | null;
  document_type?: unknown;
  document_number?: unknown;
  legal_name?: unknown;
  email?: unknown;
  phone?: unknown;
  address_line1?: unknown;
  address_line2?: unknown;
  city?: unknown;
  state_province?: unknown;
  country?: unknown;
}

const str = (v: unknown): string | null => (v === undefined || v === null || String(v).trim() === "" ? null : String(v).trim());

/** Campos de `client_billing_profiles` que el cliente SÍ dio (solo los presentes:
 * una edición no pisa lo que no se mencionó). El domicilio (calle/ciudad/país)
 * se devuelve aparte porque el llamador lo completa con DIVIPOLA. */
export function pickProfileFields(input: BillingProfileInput): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const code = input.document_type !== undefined ? mapDocumentTypeToDian(input.document_type) : null;
  if (input.document_type !== undefined && !code) throw new Error(`Tipo de documento no válido: "${String(input.document_type)}". Usa uno de: ${DOCUMENT_TYPE_LABELS.join(", ")}.`);
  if (code) {
    out.document_type_code = code;
    out.organization_type = code === "31" || code === "50" ? "1" : "2";
  }
  const simple: [string, unknown][] = [
    ["label", input.label], ["document_number", input.document_number], ["legal_name", input.legal_name],
    ["email", input.email], ["phone", input.phone], ["address_line1", input.address_line1],
    ["address_line2", input.address_line2], ["city", input.city], ["state_province", input.state_province],
  ];
  for (const [k, v] of simple) {
    if (v !== undefined) out[k] = str(v);
  }
  if (typeof out.email === "string") out.email = (out.email as string).toLowerCase();
  if (input.country !== undefined) out.country = str(input.country);
  return out;
}

/** Faltantes de un perfil (mezclando lo existente con lo nuevo): ES la lista de
 * `buildFiscalBuyer` / `billingProfileMissing`, sin reglas propias. */
export function profileMissing(row: Partial<BillingProfileRow> & Record<string, unknown>): string[] {
  const full = {
    id: "new", document_type_code: null, document_number: null, legal_name: null, email: null, phone: null,
    organization_type: "2", tax_level_code: "R-99-PN", tax_scheme_code: null, applies_withholding: false,
    address_line1: null, country: null,
    ...row,
  } as unknown as BillingProfileRow;
  return billingProfileMissing(full).missing;
}

const CAPTURE_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** El CORREO es obligatorio al CAPTURAR un perfil por WhatsApp (la IA es un
 * canal de captura), aunque el servidor ya no lo exija al emitir a un comprador
 * con nombre. Comprobación PROPIA de la herramienta: no depende de la lista de
 * faltantes de `buildFiscalBuyer`. */
export function captureEmailMissing(email: unknown): string[] {
  const v = typeof email === "string" ? email.trim() : "";
  if (!v) return ["correo de facturación"];
  return CAPTURE_EMAIL_RE.test(v) ? [] : ["correo de facturación válido"];
}

/** Faltantes para GUARDAR un perfil nuevo desde el chat: los del servidor más el
 * correo (sin duplicar si el servidor también lo reporta). */
export function newProfileMissing(row: Partial<BillingProfileRow> & Record<string, unknown>): string[] {
  const base = profileMissing(row).filter((m) => !/^correo de facturación/.test(m));
  return [...base, ...captureEmailMissing(row.email)];
}

export const EMAIL_HINT = "Pídele al cliente el correo electrónico donde enviar la factura (es obligatorio para guardar el perfil) y vuelve a llamar con todos los datos.";

export interface ProfileRowForSummary extends BillingProfileRow {
  label: string | null;
}

export interface SavedProfile {
  option: number;
  profile_id: string;
  label: string;
  legal_name: string | null;
  document_type: string | null;
  document: string;
  is_default: boolean;
  complete: boolean;
  missing: string[];
  selected: boolean;
}

/** Perfiles del cliente en texto (documento enmascarado), sin repetidos, con
 * `option` (1, 2, 3...). `selected` marca el que ya tiene el pedido en armado. */
export function buildSavedProfiles(rows: ProfileRowForSummary[], selectedProfileId: string | null = null, max = 5): SavedProfile[] {
  const seen = new Set<string>();
  const out: SavedProfile[] = [];
  for (const row of rows) {
    const key = `${row.document_type_code ?? ""}|${(row.document_number ?? "").replace(/\D/g, "")}|${normalizePlace(row.legal_name)}`;
    if (seen.has(row.id) || (key !== "||" && seen.has(key))) continue;
    seen.add(row.id);
    if (key !== "||") seen.add(key);
    if (out.length === max) break;
    const missing = profileMissing(row as unknown as Partial<BillingProfileRow> & Record<string, unknown>);
    out.push({
      option: out.length + 1,
      profile_id: row.id,
      label: row.label?.trim() || "Perfil",
      legal_name: row.legal_name?.trim() || null,
      document_type: row.document_type_code ? (DOCUMENT_CODE_LABEL[row.document_type_code] ?? row.document_type_code) : null,
      document: maskDocument(row.document_number),
      is_default: !!row.is_default,
      complete: missing.length === 0,
      missing,
      selected: selectedProfileId !== null && row.id === selectedProfileId,
    });
  }
  return out;
}

export function describeProfile(p: SavedProfile): string {
  return `${p.label}: ${p.legal_name ?? "sin nombre"} (${[p.document_type, p.document].filter(Boolean).join(" ")})`;
}

// ---------------------------------------------------------------- GATE

export interface ConfirmGateInput {
  fulfillmentMethod: string | null | undefined;
  shippingAddressId: string | null;
  /** El cliente pidió factura (lo dijo el modelo) o el pedido ya tiene un perfil elegido. */
  invoiceRequested: boolean;
  billingProfileId: string | null;
  /** Faltantes del perfil elegido (vacío si está completo o no hay perfil). */
  billingMissing: string[];
}

export type ConfirmGate =
  | null
  | { reason: "address_confirmation_required"; missing: string[] }
  | { reason: "billing_profile_required"; missing: string[] };

/** ¿Se puede confirmar la venta desde el chat? Destino SOLO si el pedido es de
 * entrega; perfil de facturación SOLO si el cliente pidió factura. Sin pedir
 * factura, nada fiscal se exige. Un método desconocido/ausente se trata como
 * entrega (el default de la columna): el guard SQL aplica la misma regla. */
export function evaluateConfirmGate(input: ConfirmGateInput): ConfirmGate {
  const isDelivery = !input.fulfillmentMethod || input.fulfillmentMethod === "delivery";
  if (isDelivery && !input.shippingAddressId) return { reason: "address_confirmation_required", missing: ["envío"] };
  if (input.invoiceRequested) {
    if (!input.billingProfileId) return { reason: "billing_profile_required", missing: ["perfil de facturación"] };
    if (input.billingMissing.length > 0) return { reason: "billing_profile_required", missing: input.billingMissing };
  }
  return null;
}
