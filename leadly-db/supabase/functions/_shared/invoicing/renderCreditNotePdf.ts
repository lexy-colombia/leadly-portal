/** Armado de la representación gráfica (PDF) de una nota crédito, extraído
 * de `sales-credit-note-pdf/index.ts` por el mismo motivo por el que se
 * extrajo `renderInvoicePdf.ts` de `sales-invoice-pdf`: la entrega por
 * correo al adquiriente necesita EXACTAMENTE el mismo documento que el
 * botón de descarga del portal, y mantener dos copias del armado garantiza
 * que se desincronicen a la primera corrección.
 *
 * Bug real que lo obligó (2026-09-10, reportado por el usuario: "al generar
 * nota crédito se envía por email es la factura"): `sendDocumentEmail.ts`
 * adjuntaba `renderInvoicePdfForOrder(...)` para CUALQUIER documento, así
 * que al aceptarse una nota crédito el comprador recibía el PDF de la
 * FACTURA junto al XML de la nota -- dos documentos distintos en el mismo
 * correo, y ninguna representación gráfica de la nota que se le estaba
 * entregando.
 *
 * A diferencia de la factura (que se lee EN VIVO del pedido, porque sigue
 * siendo editable hasta que la DIAN la acepta), una nota crédito se
 * construye y envía en el mismo acto, así que sale de su propio snapshot
 * sin volver a tocar `clients`/`sales_order_items`. */
import { buildInvoicePdf, invoiceDisplayLabel, type InvoicePdfBuyer, type InvoicePdfItem, type InvoicePdfSeller } from "./buildInvoicePdf.ts";

/** El estado no es un detalle de presentación: una nota que la DIAN nunca
 * recibió no es un documento fiscal, y generar su PDF sería fabricar algo
 * que aparenta ser válido sin serlo (mismo criterio que `isRemision` en la
 * factura). El caller decide qué código HTTP darle a este error. */
export class CreditNoteNotPrintableError extends Error {}

export async function renderCreditNotePdf(
  // deno-lint-ignore no-explicit-any
  adminClient: any,
  creditNoteId: string,
): Promise<{ bytes: Uint8Array; filename: string }> {
  const { data: creditNote } = await adminClient
    .from("sales_credit_notes")
    .select(
      "id, tenant_id, invoice_id, status, status_detail, reason_description, credit_note_prefix, credit_note_number, currency, issue_date, cude, buyer_snapshot, seller_snapshot, tax_type_code, tax_rate, subtotal, tax_total, total, created_at",
    )
    .eq("id", creditNoteId)
    .maybeSingle();
  if (!creditNote) throw new CreditNoteNotPrintableError("Nota crédito no encontrada.");
  if (creditNote.status !== "sent" && creditNote.status !== "accepted") {
    throw new CreditNoteNotPrintableError(
      `Esta nota crédito está en estado "${creditNote.status}" -- todavía no es un documento fiscal válido para generar su PDF.`,
    );
  }
  if (!creditNote.cude || !creditNote.credit_note_prefix || creditNote.credit_note_number == null) {
    throw new CreditNoteNotPrintableError("A esta nota crédito le falta el CUDE o el número asignado -- no se puede generar el PDF.");
  }

  const [{ data: invoice }, { data: tenant }, { data: credential }] = await Promise.all([
    adminClient.from("sales_invoices").select("invoice_prefix, invoice_number").eq("id", creditNote.invoice_id).maybeSingle(),
    adminClient.from("tenants").select("contact_email, contact_phone, logo_url").eq("id", creditNote.tenant_id).maybeSingle(),
    adminClient
      .from("integration_credentials")
      .select("mode")
      .eq("tenant_id", creditNote.tenant_id)
      .eq("provider_key", "dian_directo")
      .eq("is_active", true)
      .is("deleted_at", null)
      .maybeSingle(),
  ]);

  // deno-lint-ignore no-explicit-any
  const buyerSnapshot = creditNote.buyer_snapshot as any;
  // deno-lint-ignore no-explicit-any
  const sellerSnapshot = creditNote.seller_snapshot as any;

  const buyer: InvoicePdfBuyer = {
    full_name: buyerSnapshot?.full_name ?? null,
    document_type_code: buyerSnapshot?.document_type_code ?? null,
    document_number: buyerSnapshot?.document_number ?? null,
    phone: buyerSnapshot?.phone ?? null,
    email: buyerSnapshot?.email ?? null,
    address: buyerSnapshot?.address ?? null,
  };
  const seller: InvoicePdfSeller = {
    legal_name: sellerSnapshot?.legal_name ?? null,
    document_type: sellerSnapshot?.document_type ?? null,
    document_number: sellerSnapshot?.document_number ?? null,
    city: sellerSnapshot?.city ?? null,
    billing_address: sellerSnapshot?.billing_address ?? null,
    country: sellerSnapshot?.country ?? null,
    state_province: sellerSnapshot?.state_province ?? null,
    fiscal_regime: sellerSnapshot?.fiscal_regime ?? null,
    is_self_withholding_agent: Boolean(sellerSnapshot?.is_self_withholding_agent),
    // Una nota crédito no tiene resolución autorizada por la DIAN (ver
    // buildCreditNoteXml.ts) -- nunca se dibuja ese bloque acá.
    resolution: null,
    contact_email: tenant?.contact_email ?? null,
    contact_phone: tenant?.contact_phone ?? null,
  };

  const items: InvoicePdfItem[] = [
    {
      product_name: `Ajuste según nota crédito -- ${creditNote.reason_description}`,
      sku: null,
      quantity: 1,
      unit_price: creditNote.subtotal,
      subtotal: creditNote.subtotal,
      tax_type_code: creditNote.tax_type_code,
      tax_rate: creditNote.tax_rate,
      tax_amount: creditNote.tax_total,
    },
  ];

  const qrHost = credential?.mode === "production" ? "catalogo-vpfe.dian.gov.co" : "catalogo-vpfe-hab.dian.gov.co";
  const qrVerificationUrl = `https://${qrHost}/document/searchqr?documentkey=${creditNote.cude}`;

  let logoBytes: Uint8Array | null = null;
  if (tenant?.logo_url) {
    try {
      const logoRes = await fetch(tenant.logo_url);
      if (logoRes.ok) logoBytes = new Uint8Array(await logoRes.arrayBuffer());
    } catch {
      logoBytes = null;
    }
  }

  const referenceNote = invoice?.invoice_prefix && invoice.invoice_number != null ? `${invoice.invoice_prefix}${invoice.invoice_number}` : null;

  const bytes = await buildInvoicePdf({
    isRemision: false,
    documentTitle: "Nota Crédito Electrónica",
    verificationLabel: "CUDE",
    referenceNote,
    status: creditNote.status,
    statusDetail: creditNote.status_detail,
    invoicePrefix: creditNote.credit_note_prefix,
    invoiceNumber: creditNote.credit_note_number,
    issueDate: creditNote.issue_date,
    cufe: creditNote.cude,
    currency: creditNote.currency,
    subtotal: creditNote.subtotal,
    taxTotal: creditNote.tax_total,
    withholdingTotal: 0,
    total: creditNote.total,
    buyer,
    seller,
    items,
    orderNumber: creditNote.credit_note_number,
    orderCreatedAt: creditNote.created_at,
    paymentMethodLabel: null,
    qrVerificationUrl,
    notes: [],
    logoBytes,
  });

  const filename = `${invoiceDisplayLabel(creditNote.credit_note_prefix, creditNote.credit_note_number, creditNote.credit_note_number)}.pdf`;
  return { bytes, filename };
}
