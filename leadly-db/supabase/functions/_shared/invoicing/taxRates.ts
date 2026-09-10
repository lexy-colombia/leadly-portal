/**
 * Tarifas válidas por tipo de impuesto (tabla 13.3.9 del Anexo Técnico
 * v1.9, replicada de las listas oficiales que están en
 * `dian-reference/listas-de-valores/TarifaImpuesto*.gc`).
 *
 * Por qué existe este archivo (ronda 2026-09-10, rechazo real de Barriles
 * de la sexta): la plataforma deja elegir CUALQUIER combinación de tipo de
 * impuesto + tarifa en la ficha del producto (dos campos independientes),
 * pero la DIAN solo acepta las combinaciones de esta tabla. Un producto
 * cargado como "IVA 8%" (tarifa que existe para INC, no para IVA) o
 * "INC 19%" (al revés) pasa por todo el flujo de venta sin ruido y recién
 * revienta contra el servidor de la DIAN como FAX14, quemando un intento
 * de transmisión de un documento fiscal.
 *
 * FAX14 es NOTIFICACIÓN, no rechazo -- pero es una notificación que avisa
 * que el documento declara un tributo que no existe con esa tarifa, así
 * que se trata como error acá: es más barato pararlo antes de firmar y
 * transmitir que emitir un documento fiscalmente mal formado.
 */

/** Tarifas admitidas por código de impuesto DIAN (tabla 13.3.9). */
export const VALID_TAX_RATES: Record<string, number[]> = {
  "01": [0, 5, 16, 19], // IVA (TarifaImpuestoIVA-2.1.gc)
  "04": [2, 4, 8, 16], // INC (TarifaImpuestoINC-2.1.gc)
};

const TAX_NAME: Record<string, string> = { "01": "IVA", "04": "INC", "03": "ICA" };

/**
 * Devuelve un mensaje de error accionable si alguna línea declara una
 * combinación tipo+tarifa que la DIAN no admite; `null` si todas son
 * válidas. Los códigos sin tabla de tarifas fija (ICA, cuya tarifa es
 * municipal y por mil) no se validan -- no hay lista contra la cual
 * comparar.
 */
export function findInvalidTaxRate(
  lines: { description?: string; tax: { code: string; rate: number } | null }[],
): string | null {
  for (const line of lines) {
    if (!line.tax) continue;
    const allowed = VALID_TAX_RATES[line.tax.code];
    if (!allowed) continue;
    if (allowed.includes(Number(line.tax.rate))) continue;
    const name = TAX_NAME[line.tax.code] ?? line.tax.code;
    return (
      `El producto "${line.description ?? "sin nombre"}" está configurado como ${name} ${line.tax.rate}%, ` +
      `una tarifa que la DIAN no admite para ese impuesto (tabla 13.3.9: ${name} solo acepta ` +
      `${allowed.map((r) => `${r}%`).join(", ")}). Corregí el impuesto del producto y volvé a intentar.`
    );
  }
  return null;
}
