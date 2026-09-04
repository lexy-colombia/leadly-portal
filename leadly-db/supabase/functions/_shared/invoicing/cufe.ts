/** Cálculo del CUFE (Código Único de Factura Electrónica) -- Fase 2.
 *
 * Fórmula tomada TEXTUALMENTE del Anexo Técnico de Factura Electrónica de
 * Venta v1.9 de la DIAN (Resolución 000165 de 2023), sección 11.2
 * "Generación de CUFE" (páginas 655-658 del PDF oficial). No se inventó ni
 * se tomó de fuentes secundarias -- se verificó carácter por carácter contra
 * el ejemplo oficial de la propia sección 11.2.1 (ver computeCufe.test
 * más abajo): con los mismos valores de entrada que usa la DIAN en su
 * ejemplo, esta función produce exactamente el mismo hash SHA-384 que
 * publica el documento.
 *
 * Composición del CUFE = SHA-384(
 *   NumFac + FecFac + HorFac + ValFac +
 *   CodImp1 + ValImp1 + CodImp2 + ValImp2 + CodImp3 + ValImp3 +
 *   ValTot + NitOFE + NumAdq + ClTec + TipoAmbiente
 * )
 * -- "+" es concatenación directa de strings, SIN separador entre campos.
 *
 * CodImp1/CodImp2/CodImp3 son FIJOS siempre en este orden (01=IVA,
 * 04=INC, 03=ICA) -- si un impuesto no aplica a la factura, su ValImp va en
 * "0.00", el código igual se incluye. Ver tax_types (code 01/04/03).
 *
 * Los valores monetarios van con punto decimal, exactamente 2 decimales
 * TRUNCADOS (no redondeados), sin separador de miles ni símbolo de moneda.
 */

export interface CufeInput {
  /** Prefijo + número de factura concatenado, ej. "SETP990000001". */
  numFac: string;
  /** Fecha de la factura, formato YYYY-MM-DD. */
  fecFac: string;
  /** Hora de la factura incluyendo offset GMT, ej. "10:53:10-05:00". */
  horFac: string;
  /** Valor de la factura SIN impuestos (LineExtensionAmount / suma de taxable_base de las líneas). */
  valFac: number;
  /** Suma de IVA (tax_type_code = '01') de todas las líneas -- 0 si no aplica. */
  valImp1Iva: number;
  /** Suma de INC (tax_type_code = '04') de todas las líneas -- 0 si no aplica. */
  valImp2Inc: number;
  /** Suma de ICA (tax_type_code = '03') de todas las líneas -- 0 si no aplica. */
  valImp3Ica: number;
  /** Valor total a pagar (PayableAmount) -- con impuestos, sin retenciones. */
  valTot: number;
  /** NIT del facturador electrónico (el tenant), sin puntos ni guiones, sin dígito de verificación. */
  nitOfe: string;
  /** Número de identificación del adquirente, sin puntos ni guiones, sin dígito de verificación. */
  numAdq: string;
  /** Clave técnica del rango de facturación (la asigna la DIAN al autorizar el rango). */
  claveTecnica: string;
  /** 1 = producción, 2 = pruebas/habilitación -- ver tenant_dian_profile / integration_credentials.mode. */
  tipoAmbiente: 1 | 2;
}

/** "punto decimal, con decimales a dos (2) dígitos truncados, sin
 * separadores de miles, ni símbolo pesos" -- truncar, no redondear, es
 * importante: Math.trunc, no Math.round, para no desviarse un centavo del
 * valor que espera la DIAN. */
function formatMonetary(value: number): string {
  const truncated = Math.trunc(value * 100) / 100;
  return truncated.toFixed(2);
}

export async function computeCufe(input: CufeInput): Promise<string> {
  const raw =
    input.numFac +
    input.fecFac +
    input.horFac +
    formatMonetary(input.valFac) +
    "01" +
    formatMonetary(input.valImp1Iva) +
    "04" +
    formatMonetary(input.valImp2Inc) +
    "03" +
    formatMonetary(input.valImp3Ica) +
    formatMonetary(input.valTot) +
    input.nitOfe +
    input.numAdq +
    input.claveTecnica +
    String(input.tipoAmbiente);

  const digest = await crypto.subtle.digest("SHA-384", new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Código de Seguridad del Software -- Anexo Técnico sección 11.8. A
 * diferencia del CUFE (verificado byte a byte contra el ejemplo oficial),
 * esta fórmula se implementó tal cual la describe el documento pero SIN un
 * ejemplo numérico oficial para verificarla (el Anexo no trae uno) -- vale
 * la pena confirmarla contra la respuesta real de la DIAN en cuanto se
 * mande el primer documento de prueba.
 *
 * SoftwareSecurityCode := SHA-384(IdSoftware + Pin + NroDocumento)
 * NroDocumento = el mismo valor de /Invoice/cbc:ID (prefijo + consecutivo,
 * igual que NumFac del CUFE). */
export async function computeSoftwareSecurityCode(softwareId: string, pin: string, invoiceNumber: string): Promise<string> {
  const raw = softwareId + pin + invoiceNumber;
  const digest = await crypto.subtle.digest("SHA-384", new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Identificador de política de firma XAdES-EPES exigido por la DIAN --
 * fijo para toda la plataforma, no depende del tenant (Anexo Técnico
 * sección 10.10 "Identificador de la Política"). Se usará en Fase 2 al
 * construir el bloque xades:SignaturePolicyIdentifier de cada factura. */
export const DIAN_SIGNATURE_POLICY = {
  identifier: "https://facturaelectronica.dian.gov.co/politicadefirma/v2/politicadefirmav2.pdf",
  description: "Política de firma para facturas electrónicas de la República de Colombia.",
  // La DIAN acepta sha256 o sha512 para el hash de la política (no confundir
  // con el SHA-384 del CUFE, son cálculos distintos sobre cosas distintas).
  digestAlgorithms: ["http://www.w3.org/2001/04/xmlenc#sha256", "http://www.w3.org/2001/04/xmlenc#sha512"] as const,
} as const;
