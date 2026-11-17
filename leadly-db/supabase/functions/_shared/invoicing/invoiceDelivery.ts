/** Dirección de entrega de la factura (`cac:Delivery/cac:DeliveryAddress`).
 *
 * Base legal/técnica:
 *  - Res. DIAN 227/2025, art. 1.5.1.2.2.1, num. 3.3: se debe registrar la
 *    dirección del lugar de entrega cuando la venta se hace fuera de la sede
 *    del facturador y el adquirente se identifica como en los numerales 3.2
 *    (sin NIT: cédula, etc.) o 3.3 (consumidor final). Con NIT (3.1) no es
 *    obligatoria. Entrega en el exterior: no obligatoria.
 *  - Anexo Técnico v1.9: FAM01 `cac:Delivery` 0..1; si se informa
 *    `DeliveryAddress` (FAM04), `AddressLine/Line` (FAM09/FAM10) y
 *    `Country/IdentificationCode` (FAM11/FAM12) son obligatorios (rechazo);
 *    `cbc:ID` (FAM05) y `CountrySubentityCode` (FAM08) deben ser DIVIPOLA
 *    válidos si el país es CO (rechazo). CityName/CountrySubentity/PostalZone
 *    son solo notificación.
 *
 * Regla de este módulo (PURA, sin I/O; probada en tests/invoicing):
 *  - El grupo se emite SOLO si el pedido es de entrega (`fulfillment_method =
 *    'delivery'`), el destino es de Colombia, tiene línea de dirección real y
 *    municipio+departamento DIVIPOLA que existen en el catálogo. Nunca se
 *    emite a medias (provocaría rechazo FAM05/FAM08/FAM09/FAM10).
 *  - Entrega fuera de Colombia: se omite (la resolución no la exige y emitir
 *    solo suma superficie de rechazo).
 *  - Bloqueo: con `requireDane` (REQUIRE_DANE_FOR_DELIVERY, hoy false) y un
 *    adquirente que NO es NIT (tipo de documento != '31'), un domicilio sin
 *    destino completo deja la factura en blocked_missing_buyer_data. Con NIT
 *    es opcional y nunca bloquea.
 *
 * No toca nada que entre al CUFE ni a los totales: es solo estructura. */
import { PLACEHOLDER_RE } from "../orders/fulfillmentAndBilling.ts";

/** INTERRUPTOR GENERAL (decisión del usuario, 2026-11): la factura NO lleva
 * `cac:Delivery` en ningún caso. Con `false`:
 *  - `evaluateInvoiceDelivery` devuelve siempre "omitir" (sin delivery y sin
 *    faltantes), así que `queueInvoiceGeneration` no arma
 *    `buyer_snapshot.delivery`, no consulta el catálogo para eso y no agrega
 *    ningún faltante por entrega;
 *  - `mapInvoiceDelivery` ignora un `buyer_snapshot.delivery` ya guardado por
 *    una ronda anterior, y `buildInvoiceXml` nunca recibe `delivery`;
 *  - la regla de bloqueo (`REQUIRE_DANE_FOR_DELIVERY`) queda INERTE: código
 *    latente, listo para reactivarse.
 * Para volver a emitir: cambiar esta línea a `true` (y redesplegar). Las
 * pruebas ejercitan la lógica con el override explícito `emit: true`. */
export const EMIT_DELIVERY_IN_XML = false;

/** Faltante que ve el usuario cuando el destino no tiene DIVIPOLA completo. */
export const DELIVERY_DIVIPOLA_MISSING = "departamento y municipio de entrega";
/** Faltante cuando ni siquiera hay una línea de dirección utilizable. */
export const DELIVERY_ADDRESS_MISSING = "dirección de entrega";


/** Destino ya validado, tal como se guarda en `buyer_snapshot.delivery`. */
export interface InvoiceDeliverySnapshot {
  /** Línea de dirección ya compuesta (línea 1 + línea 2), sin ciudad ni
   * departamento, máx. 300 caracteres (FAM10). */
  line1: string;
  /** Nombre del municipio, del catálogo `cities`. */
  city: string;
  /** Nombre del departamento, del catálogo `departments`. */
  state_province: string;
  country: "CO";
  /** DIVIPOLA municipio (5 dígitos, ej. "11001"). */
  city_code: string;
  /** DIVIPOLA departamento (2 dígitos, ej. "11"). */
  state_code: string;
}

export interface EvaluateInvoiceDeliveryInput {
  /** `sales_orders.fulfillment_method`. */
  fulfillmentMethod: string | null | undefined;
  /** `sales_orders.shipping_snapshot` (destino congelado). */
  shippingSnapshot: Record<string, unknown> | null | undefined;
  /** Tipo de documento DIAN del adquirente ('31' = NIT). */
  buyerDocumentTypeCode: string | null | undefined;
  /** Nombres del catálogo si `city_code`+`state_code` existen y son
   * compatibles (municipio pertenece al departamento); null si no. */
  divipola: { cityName: string; departmentName: string } | null;
  requireDane: boolean;
  /** Override (pruebas): por defecto `EMIT_DELIVERY_IN_XML`. */
  emit?: boolean;
}

export interface EvaluateInvoiceDeliveryResult {
  delivery: InvoiceDeliverySnapshot | null;
  /** Faltantes que bloquean la factura (vacío si no aplica). */
  missing: string[];
}

/** País de Colombia, ESTRICTO: la cadena vacía/ausente NO cuenta (a diferencia
 * de `isColombia` de fulfillmentAndBilling.ts, que la acepta). Sin país el
 * Anexo rechaza (FAM12) y asumir CO sería inventar el dato. */
function isColombianCountry(country: string | null): boolean {
  const c = (country ?? "").trim().toLowerCase();
  return c === "co" || c === "colombia";
}

/** Deja un texto apto para `cbc:Line` (XML 1.0): quita caracteres de control
 * no válidos (U+0000-0008, 000B, 000C, 000E-001F, FFFE, FFFF y sustitutos
 * sueltos), colapsa saltos de línea/tabs/espacios repetidos a un espacio y
 * recorta a `max` CODE POINTS (nunca parte un par sustituto/emoji). */
export function sanitizeAddressLine(raw: string, max = 300): string {
  const cleaned = raw
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "")
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "")
    .replace(/(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "$1")
    .replace(/[\t\r\n\u0085\u2028\u2029]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
  return Array.from(cleaned).slice(0, max).join("").trim();
}

function text(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/** ¿El snapshot de destino necesita consultar el catálogo DIVIPOLA? Solo si es
 * de Colombia y trae ambos códigos (para no consultar en vano). */
export function deliveryDivipolaCodes(shippingSnapshot: Record<string, unknown> | null | undefined): { cityCode: string; stateCode: string } | null {
  if (!shippingSnapshot) return null;
  if (!isColombianCountry(text(shippingSnapshot.country))) return null;
  const cityCode = text(shippingSnapshot.city_code);
  const stateCode = text(shippingSnapshot.state_code);
  return cityCode && stateCode ? { cityCode, stateCode } : null;
}

export function evaluateInvoiceDelivery(input: EvaluateInvoiceDeliveryInput): EvaluateInvoiceDeliveryResult {
  if (!(input.emit ?? EMIT_DELIVERY_IN_XML)) return { delivery: null, missing: [] };
  if (input.fulfillmentMethod !== "delivery") return { delivery: null, missing: [] };

  const snap = input.shippingSnapshot ?? null;
  // Entrega en el exterior: no obligatoria y no se emite (juicio documentado arriba).
  if (snap && text(snap.country) && !isColombianCountry(text(snap.country))) return { delivery: null, missing: [] };

  const blocksIfIncomplete = input.requireDane && input.buyerDocumentTypeCode !== "31";

  const line1 = sanitizeAddressLine(text(snap?.line1) ?? "");
  if (!snap || line1 === "" || PLACEHOLDER_RE.test(line1)) {
    return { delivery: null, missing: blocksIfIncomplete ? [DELIVERY_ADDRESS_MISSING] : [] };
  }

  const codes = deliveryDivipolaCodes(snap);
  if (!codes || !input.divipola) {
    return { delivery: null, missing: blocksIfIncomplete ? [DELIVERY_DIVIPOLA_MISSING] : [] };
  }

  // FAM10: "Informar la dirección, sin ciudad ni departamento", 1-300. La línea
  // 2 (apto, torre, referencia) es parte de cómo llegar y va en el mismo texto.
  const line2 = sanitizeAddressLine(text(snap.line2) ?? "");
  const full = sanitizeAddressLine(line2 ? `${line1}, ${line2}` : line1);
  return {
    delivery: {
      line1: full,
      city: input.divipola.cityName,
      state_province: input.divipola.departmentName,
      country: "CO",
      city_code: codes.cityCode,
      state_code: codes.stateCode,
    },
    missing: [],
  };
}
