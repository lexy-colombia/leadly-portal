/** Fecha y hora de emisión de un documento electrónico, en la hora real de
 * Colombia.
 *
 * ⚠️ Bug real corregido 2026-09-10: los tres emisores (sendInvoiceToDian /
 * sendCreditNoteToDian / sendToDian) armaban la hora como
 * `new Date().toISOString().slice(11, 19) + "-05:00"` -- eso toma la hora
 * UTC y le PEGA el offset colombiano sin convertir nada, así que el
 * documento declaraba una hora cinco horas adelantada respecto de la real
 * (una factura emitida 13:48 en Colombia salía como "18:48:49-05:00"). Y
 * entre las 19:00 y la medianoche hora de Colombia el problema es peor: el
 * `slice(0, 10)` de la MISMA cadena UTC ya cayó al día siguiente, así que
 * `cbc:IssueDate` adelantaba la fecha un día entero. Ambos valores entran
 * al CUFE/CUDE tal cual, además de imprimirse en la representación gráfica.
 *
 * Colombia es UTC-5 fijo (sin horario de verano desde 1993), así que
 * desplazar el instante y leerlo como UTC da exactamente el reloj de pared
 * local -- no hace falta `Intl`/tz database para esto. */
export const COLOMBIA_UTC_OFFSET_MINUTES = -5 * 60;
export const COLOMBIA_OFFSET_SUFFIX = "-05:00";

export interface ColombiaIssueMoment {
  /** `cbc:IssueDate`, formato YYYY-MM-DD. */
  issueDate: string;
  /** `cbc:IssueTime`, formato HH:MM:SS-05:00 (la DIAN exige el GMT). */
  issueTime: string;
}

/** Reloj de pared colombiano del instante `instant` (por defecto, ahora). */
export function colombiaIssueMoment(instant: Date = new Date()): ColombiaIssueMoment {
  const shifted = new Date(instant.getTime() + COLOMBIA_UTC_OFFSET_MINUTES * 60_000);
  const iso = shifted.toISOString();
  return { issueDate: iso.slice(0, 10), issueTime: iso.slice(11, 19) + COLOMBIA_OFFSET_SUFFIX };
}
