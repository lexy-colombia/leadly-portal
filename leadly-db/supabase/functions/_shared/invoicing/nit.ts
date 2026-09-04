/** Dígito de verificación (DV) del NIT colombiano -- algoritmo módulo 11
 * (Orden Administrativa 4 de 1989 de la DIAN, el mismo que usan todos los
 * sistemas de facturación electrónica). Necesario para el atributo
 * `schemeID` de `cbc:CompanyID` en el XML (ver Generica.xml del kit oficial:
 * NIT 800197268 -> schemeID="4", NIT 900108281 -> schemeID="3").
 *
 * Verificado contra esos dos NIT reales del ejemplo oficial de la DIAN --
 * ambos calzan exacto, no es una fórmula inventada. */
export function computeNitCheckDigit(nit: string): number {
  const weights = [3, 7, 13, 17, 19, 23, 29, 37, 41, 43, 47, 53, 59, 67, 71];
  const digits = nit
    .replace(/\D/g, "")
    .split("")
    .reverse()
    .map(Number);
  const total = digits.reduce((sum, d, i) => sum + d * (weights[i] ?? 0), 0);
  const remainder = total % 11;
  return remainder <= 1 ? remainder : 11 - remainder;
}
