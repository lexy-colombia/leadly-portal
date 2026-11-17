/** Validación del correo del COMPROBANTE (`invoice_email`, Consumidor Final)
 * que llega a dian-submit. Devuelve el correo normalizado (trim) o null si no es
 * válido: typeof string, <= 254 caracteres y formato razonable (RFC 5322
 * simplificado: sin <, >, comillas, espacios ni puntos dobles al borde). */
const INVOICE_EMAIL_RE =
  /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

export function parseInvoiceEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim();
  if (!email || email.length > 254 || !INVOICE_EMAIL_RE.test(email)) return null;
  return email;
}
