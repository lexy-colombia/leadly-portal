/** Resuelve la CLAVE TÉCNICA («ClTec») que entra al cálculo del CUFE.
 *
 * ⚠️ Bug real de producción, 2026-09-10: la clave técnica se guardaba una
 * sola vez a mano en Integraciones y no se volvía a tocar nunca. Pero la
 * clave técnica NO es una credencial del tenant ni del software -- el Anexo
 * Técnico v1.9, numeral 11.6, dice textualmente que "está asociada al Rango
 * de Facturación del que tomó el prefijo y el número de la factura
 * electrónica que será firmada", y remata con una advertencia: al autorizar
 * un rango nuevo, el servicio de numeración "le entregará una nueva CLAVE
 * TÉCNICA, esta CLAVE TÉCNICA es diferente a la del anterior rango".
 *
 * Consecuencia concreta que se vio en vivo: el tenant configuró la clave del
 * rango sintético de HABILITACIÓN (prefijo SETP, que la DIAN fabrica sola,
 * ver numeral 7.15.1) y después pasó a producción con su resolución real
 * -- otro rango, otra clave. La DIAN recalcula el CUFE con la clave que
 * ella tiene registrada para ese rango, así que el hash nunca cerraba y
 * rechazaba con FAD06 ("Valor del CUFE no está calculado correctamente"),
 * sin ninguna forma de saber desde el mensaje que el problema era la clave.
 *
 * Por eso en producción la clave deja de leerse del campo manual y se pide
 * a la DIAN misma con `GetNumberingRange`, eligiendo el rango que de verdad
 * contiene el número que se está por emitir. El campo manual queda como
 * respaldo (si el web service falla o no devuelve un rango que matchee),
 * para que una caída puntual de la DIAN no bloquee la facturación.
 *
 * En habilitación NO se consulta nada: el numeral 7.15.1 aclara que
 * `GetNumberingRange` "estará disponible únicamente en el ambiente de
 * producción en operación", porque en habilitación es el propio catálogo de
 * participantes el que genera el rango y su clave. Ahí el valor cargado a
 * mano es la única fuente posible. */
import { getTenantNumberingRangeFromDian } from "./getNumberingRange.ts";

/** Caché por isolate -- `GetNumberingRange` es un round-trip SOAP con mTLS,
 * y el rango de un tenant no cambia entre dos facturas seguidas. Se guarda
 * por tenant+prefijo y expira sola, así que un rango nuevo entra al día
 * siguiente sin tener que reiniciar nada (y sin quedar cacheado para
 * siempre, que sería reintroducir el mismo problema que este archivo
 * resuelve). */
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { technicalKey: string; expiresAt: number }>();

export interface ResolveTechnicalKeyInput {
  // deno-lint-ignore no-explicit-any
  adminClient: any;
  tenantId: string;
  /** `integration_credentials.mode === "production"`. */
  isProduction: boolean;
  /** Prefijo de la resolución con la que se emite (ej. "FE"). */
  prefix: string;
  /** Consecutivo que se está por emitir -- se usa para elegir el rango
   * correcto cuando el tenant tiene más de una resolución vigente. */
  documentNumber: number;
  /** Lo cargado a mano en Integraciones (`technical_key`). */
  storedKey: string | null;
}

export interface ResolveTechnicalKeyResult {
  technicalKey: string;
  /** De dónde salió realmente -- se registra en `dian_response` para que un
   * rechazo futuro por CUFE sea diagnosticable sin adivinar. */
  source: "dian" | "stored";
  /** Por qué se cayó al valor manual, cuando aplica. */
  fallbackReason: string | null;
}

export async function resolveTechnicalKey(input: ResolveTechnicalKeyInput): Promise<ResolveTechnicalKeyResult> {
  const stored = input.storedKey?.trim() || null;

  if (!input.isProduction) {
    if (!stored) {
      throw new Error(
        "Falta la clave técnica en Integraciones. En habilitación la asigna el catálogo de participantes de la DIAN junto con el rango de pruebas -- no se puede consultar por web service.",
      );
    }
    return { technicalKey: stored, source: "stored", fallbackReason: null };
  }

  const cacheKey = `${input.tenantId}|${input.prefix}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { technicalKey: cached.technicalKey, source: "dian", fallbackReason: null };
  }

  let fallbackReason: string | null = null;
  try {
    const result = await getTenantNumberingRangeFromDian(input.adminClient, input.tenantId);
    if (result.faultReason) {
      fallbackReason = `La DIAN rechazó la consulta de rangos: ${result.faultReason}`;
    } else {
      const match = result.ranges.find(
        (range) =>
          (range.prefix ?? "").trim().toUpperCase() === input.prefix.trim().toUpperCase() &&
          (range.rangeFrom == null || input.documentNumber >= range.rangeFrom) &&
          (range.rangeTo == null || input.documentNumber <= range.rangeTo) &&
          !!range.technicalKey?.trim(),
      );
      if (match?.technicalKey) {
        const technicalKey = match.technicalKey.trim();
        cache.set(cacheKey, { technicalKey, expiresAt: Date.now() + CACHE_TTL_MS });
        return { technicalKey, source: "dian", fallbackReason: null };
      }
      fallbackReason =
        result.ranges.length === 0
          ? `La DIAN no devolvió ningún rango de numeración${result.operationDescription ? ` (${result.operationDescription})` : ""}.`
          : `Ninguno de los ${result.ranges.length} rangos que devolvió la DIAN corresponde al prefijo "${input.prefix}" con el número ${input.documentNumber}.`;
    }
  } catch (err) {
    fallbackReason = `No se pudo consultar el rango de numeración: ${err instanceof Error ? err.message : String(err)}`;
  }

  if (!stored) {
    throw new Error(
      `${fallbackReason} Tampoco hay una clave técnica cargada a mano en Integraciones como respaldo, así que no se puede calcular el CUFE.`,
    );
  }
  return { technicalKey: stored, source: "stored", fallbackReason };
}
