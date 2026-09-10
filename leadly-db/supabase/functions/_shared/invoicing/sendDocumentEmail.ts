/** Entrega del documento electrónico al adquiriente por correo -- Anexo
 * Técnico numeral 9.3, que lista el correo a la dirección suministrada por
 * el adquiriente como uno de los medios autorizados de entrega, en
 * representación gráfica (el PDF) y/o en formato electrónico de generación
 * (el XML firmado).
 *
 * Alcance real, sin sobrevender: se entrega el PDF y el XML firmado tal
 * cual se transmitió. NO se arma el `AttachedDocument` (el contenedor XML
 * que envuelve la factura junto con el ApplicationResponse de validación de
 * la DIAN, numerales 6.4/8.5) -- eso es un documento aparte que esta
 * plataforma todavía no construye. La primera opción del numeral 9.3
 * (entrega de la representación gráfica por correo) se cumple igual por sí
 * sola; el XML va como valor agregado.
 *
 * NUNCA lanza. Toda salida -- éxito, error del proveedor, o "no había a
 * quién mandarle" -- queda registrada en `sales_document_emails`, que es
 * append-only: un reenvío es una fila nueva, nunca una edición. Esa
 * bitácora es la evidencia de cumplimiento de la entrega. */
import { renderInvoicePdfForOrder, bytesToBase64 } from "./renderInvoicePdf.ts";
import { renderCreditNotePdf } from "./renderCreditNotePdf.ts";
import { fetchStoredXml } from "./storeSignedXml.ts";
import { sendEmail, platformFromAddress, type EmailAttachment } from "../email/resend.ts";
import { buildDocumentEmailHtml, documentEmailSubject, type DocumentKind } from "./documentEmailTemplate.ts";

export interface SendDocumentEmailResult {
  /** `sent`: el proveedor aceptó el mensaje. `skipped`: no había a quién
   * mandarlo (ver abajo, NO es un error). `error`: se intentó y falló. */
  outcome: "sent" | "skipped" | "error";
  recipient: string | null;
  detail: string | null;
}

interface Target {
  kind: DocumentKind;
  table: "sales_invoices" | "sales_credit_notes";
  id: string;
}

/** Manda el documento `target` del tenant `tenantId` al correo del
 * adquiriente. `triggeredBy` distingue el envío automático al aceptar la
 * DIAN del reenvío manual desde el portal (y `actorId` deja quién lo pidió,
 * solo en el manual). */
export async function sendDocumentEmail(
  // deno-lint-ignore no-explicit-any
  adminClient: any,
  tenantId: string,
  target: Target,
  triggeredBy: "auto" | "manual",
  actorId: string | null = null,
): Promise<SendDocumentEmailResult> {
  try {
    return await doSend(adminClient, tenantId, target, triggeredBy, actorId);
  } catch (err) {
    // Red de seguridad: cualquier cosa no contemplada queda registrada y
    // devuelta como error, nunca propagada -- este camino cuelga de la
    // aceptación de una factura, y una factura aceptada no puede "fallar"
    // porque no se pudo mandar un correo.
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`[sendDocumentEmail] ${target.table}/${target.id}:`, detail);
    await logDelivery(adminClient, tenantId, target, {
      recipient: "(desconocido)",
      subject: "(no se llegó a armar)",
      status: "error",
      providerMessageId: null,
      errorDetail: detail,
      attachments: [],
      triggeredBy,
      actorId,
    });
    return { outcome: "error", recipient: null, detail };
  }
}

// deno-lint-ignore no-explicit-any
async function doSend(adminClient: any, tenantId: string, target: Target, triggeredBy: "auto" | "manual", actorId: string | null): Promise<SendDocumentEmailResult> {
  const isInvoice = target.kind === "invoice";
  const columns = isInvoice
    ? "id, order_id, status, invoice_prefix, invoice_number, cufe, issue_date, total, currency, buyer_snapshot, xml_storage_path"
    : "id, invoice_id, status, credit_note_prefix, credit_note_number, cude, issue_date, total, currency, buyer_snapshot, xml_storage_path";
  const { data: row } = await adminClient.from(target.table).select(columns).eq("id", target.id).eq("tenant_id", tenantId).maybeSingle();
  if (!row) throw new Error("Documento no encontrado.");

  const buyer = (row.buyer_snapshot ?? {}) as { full_name?: string | null; email?: string | null };
  const recipient = (buyer.email ?? "").trim();
  if (!recipient) {
    // Caso legítimo y frecuente, NO un error: una venta de mostrador a
    // "Consumidor Final" no tiene correo. El propio numeral 9.3 lo
    // contempla -- "si el adquirente no informa o señala el medio de
    // recepción... se deberá expedir una Impresión de representación
    // gráfica", que es exactamente el tiquete que ya imprime el POS.
    await logDelivery(adminClient, tenantId, target, {
      recipient: "(sin correo)",
      subject: "(no enviado)",
      status: "error",
      providerMessageId: null,
      errorDetail: "El adquiriente no tiene correo cargado -- la entrega se cumple con la impresión de la representación gráfica (numeral 9.3).",
      attachments: [],
      triggeredBy,
      actorId,
    });
    return { outcome: "skipped", recipient: null, detail: "El cliente no tiene correo cargado." };
  }

  const { data: tenant } = await adminClient
    .from("tenants")
    .select("name, legal_name, document_number, contact_email, logo_url")
    .eq("id", tenantId)
    .maybeSingle();
  const { data: dianProfile } = await adminClient.from("tenant_dian_profile").select("city").eq("tenant_id", tenantId).maybeSingle();
  const { data: credential } = await adminClient
    .from("integration_credentials")
    .select("mode")
    .eq("tenant_id", tenantId)
    .eq("provider_key", "dian_directo")
    .eq("is_active", true)
    .is("deleted_at", null)
    .maybeSingle();

  // La representación gráfica adjunta es la del DOCUMENTO que se está
  // entregando, no la del pedido: una factura sale del pedido (sigue vivo
  // y editable hasta que la DIAN la acepta) y una nota crédito de su propio
  // snapshot.
  //
  // Bug real corregido acá (2026-09-10, reportado por el usuario: "al
  // generar nota crédito se envía por email es la factura"): esta rama
  // usaba `renderInvoicePdfForOrder` para los DOS casos, resolviendo el
  // pedido de la nota a través de su factura -- así que el comprador
  // recibía el PDF de la factura junto al XML de la nota crédito, dos
  // documentos distintos en el mismo correo, sin ninguna representación
  // gráfica de lo que en realidad se le estaba entregando.
  const attachments: EmailAttachment[] = [];
  if (isInvoice) {
    if (row.order_id) {
      const pdf = await renderInvoicePdfForOrder(adminClient, row.order_id);
      attachments.push({ filename: pdf.filename, content: bytesToBase64(pdf.bytes) });
    }
  } else {
    // Nunca tumba la entrega: si el PDF no se puede armar, el XML firmado
    // adjunto sigue cumpliendo el numeral 9.3 por sí solo (y si tampoco
    // hay XML, más abajo se corta antes de mandar un correo vacío).
    try {
      const pdf = await renderCreditNotePdf(adminClient, target.id);
      attachments.push({ filename: pdf.filename, content: bytesToBase64(pdf.bytes) });
    } catch (err) {
      console.error(`[sendDocumentEmail] PDF de nota crédito ${target.id}:`, err instanceof Error ? err.message : String(err));
    }
  }

  const fiscalCode = (isInvoice ? row.cufe : row.cude) ?? null;
  const prefix = isInvoice ? row.invoice_prefix : row.credit_note_prefix;
  const number = isInvoice ? row.invoice_number : row.credit_note_number;
  const documentLabel = prefix && number != null ? `${prefix}-${number}` : `${prefix ?? ""}${number ?? ""}` || "Documento";

  // El XML se adjunta solo si de verdad se conservó -- si `xml_storage_path`
  // quedó en null (Storage caído en el momento del envío, ver
  // storeSignedXml.ts) se manda el PDF solo, que ya cumple el numeral 9.3
  // por sí mismo. Mejor entregar algo válido que no entregar nada.
  const xml = await fetchStoredXml(adminClient, row.xml_storage_path ?? null);
  if (xml) {
    attachments.push({ filename: `${documentLabel.replace(/[^A-Za-z0-9._-]/g, "")}.xml`, content: btoa(unescape(encodeURIComponent(xml))) });
  }

  if (attachments.length === 0) {
    throw new Error("No se pudo generar ningún adjunto (ni PDF ni XML) -- no se manda un correo de entrega vacío.");
  }

  const qrHost = credential?.mode === "production" ? "catalogo-vpfe.dian.gov.co" : "catalogo-vpfe-hab.dian.gov.co";
  const isValidated = row.status === "accepted" || row.status === "sent";
  const sellerName = tenant?.name ?? tenant?.legal_name ?? "Tu proveedor";

  const templateInput = {
    kind: target.kind,
    sellerName,
    sellerLegalName: tenant?.legal_name ?? null,
    sellerDocument: tenant?.document_number ?? null,
    sellerCity: dianProfile?.city ?? null,
    sellerEmail: tenant?.contact_email ?? null,
    sellerLogoUrl: tenant?.logo_url ?? null,
    buyerName: buyer.full_name ?? null,
    documentLabel,
    issueDateLabel: formatIssueDate(row.issue_date),
    totalLabel: formatMoney(Number(row.total ?? 0), row.currency ?? "COP"),
    // Solo se declara "validado por la DIAN" con la prueba concreta:
    // estado validado Y código fiscal real. Mismo criterio que `isRemision`
    // en el PDF -- nunca aparentar un comprobante que no existe.
    fiscalCode: isValidated && fiscalCode ? fiscalCode : null,
    verificationUrl: isValidated && fiscalCode ? `https://${qrHost}/document/searchqr?documentkey=${fiscalCode}` : null,
    attachments: attachments.map((a) => a.filename),
  };

  const subject = documentEmailSubject(templateInput);
  const result = await sendEmail({
    from: platformFromAddress(sellerName),
    to: recipient,
    replyTo: tenant?.contact_email ?? null,
    subject,
    html: buildDocumentEmailHtml(templateInput),
    attachments,
  });

  await logDelivery(adminClient, tenantId, target, {
    recipient,
    subject,
    status: result.ok ? "sent" : "error",
    providerMessageId: result.messageId,
    errorDetail: result.error,
    attachments: attachments.map((a) => a.filename),
    triggeredBy,
    actorId,
  });

  return result.ok
    ? { outcome: "sent", recipient, detail: null }
    : { outcome: "error", recipient, detail: result.error };
}

// deno-lint-ignore no-explicit-any
async function logDelivery(adminClient: any, tenantId: string, target: Target, entry: {
  recipient: string;
  subject: string;
  status: "sent" | "error";
  providerMessageId: string | null;
  errorDetail: string | null;
  attachments: string[];
  triggeredBy: "auto" | "manual";
  actorId: string | null;
}): Promise<void> {
  const { error } = await adminClient.from("sales_document_emails").insert({
    tenant_id: tenantId,
    invoice_id: target.kind === "invoice" ? target.id : null,
    credit_note_id: target.kind === "credit_note" ? target.id : null,
    recipient: entry.recipient,
    subject: entry.subject,
    status: entry.status,
    provider_message_id: entry.providerMessageId,
    error_detail: entry.errorDetail,
    attachments: entry.attachments,
    triggered_by: entry.triggeredBy,
    created_by: entry.actorId,
  });
  // Si ni siquiera se puede escribir la bitácora, se loguea y se sigue --
  // no tiene sentido tumbar el flujo por el registro de una entrega que
  // (en el caso de éxito) YA ocurrió.
  if (error) console.error("[sendDocumentEmail] no se pudo registrar la entrega:", error.message);
}

function formatIssueDate(value: string | null): string {
  if (!value) return "—";
  try {
    // Hora de Colombia -- ver colombiaTime.ts para el porqué de no usar la
    // hora UTC cruda en nada que vea un usuario.
    return new Intl.DateTimeFormat("es-CO", { day: "numeric", month: "long", year: "numeric", timeZone: "America/Bogota" }).format(new Date(value));
  } catch {
    return String(value).slice(0, 10);
  }
}

function formatMoney(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat("es-CO", { style: "currency", currency, maximumFractionDigits: 0 }).format(value);
  } catch {
    return `${value}`;
  }
}
