/** Empaqueta el/los XML(s) firmados en un .zip, tal como lo exige
 * SendTestSetAsync/SendBillAsync (Anexo Técnico §7.8/7.9: "Se debe generar
 * un ZIP con uno o más documentos electrónicos firmados... en formato UBL").
 *
 * Usa `fflate` (vía npm:) en vez de armar el formato ZIP a mano -- probado
 * en el runtime real de Deno, produce un .zip válido (verificado con
 * `unzip -l` del lado de este mismo proyecto).
 *
 * ⚠️ `level: 0` (STORE, sin comprimir) fue RECHAZADO por la DIAN en
 * producción con "MIMEType del archivo inválido (text/xml)" -- el validador
 * de zips de la DIAN parece no reconocer como zip válido un archivo sin
 * compresión real y cae a adivinar el mimetype del contenido crudo. Se pasó
 * a `level: 6` (DEFLATE estándar) -- método de compresión universalmente
 * soportado, y el único que aparece documentado en foros de otros
 * integradores que reportaron el mismo error. */
import { zipSync } from "npm:fflate@0.8";

export interface ZipEntry {
  fileName: string;
  content: Uint8Array;
}

export function buildInvoiceZip(entries: ZipEntry[]): Uint8Array {
  if (entries.length === 0) throw new Error("No hay ningún documento para empaquetar en el ZIP.");
  if (entries.length > 50) throw new Error("La DIAN acepta máximo 50 documentos por ZIP (Anexo Técnico §7.8).");

  const files: Record<string, Uint8Array> = {};
  for (const entry of entries) files[entry.fileName] = entry.content;

  return zipSync(files, { level: 6 });
}
