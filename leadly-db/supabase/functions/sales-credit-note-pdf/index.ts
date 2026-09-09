/** Genera la representación gráfica (PDF) de una nota crédito ya enviada a
 * la DIAN -- mismo motivo que sales-invoice-pdf: el CUDE solo no le sirve a
 * nadie, pedido explícito del usuario ("y como descargo o visualizo la
 * nota crédito?", 2026-09-09) apenas después de poder emitirlas.
 *
 * A diferencia de sales-invoice-pdf (que lee EN VIVO del pedido, porque una
 * factura sigue siendo editable hasta que la DIAN la acepta), una nota
 * crédito se construye y envía en el mismo acto -- nunca queda "a medio
 * editar" después de creada, así que este PDF sale directo de su propio
 * snapshot (buyer_snapshot/seller_snapshot/tax_type_code/tax_rate/
 * subtotal/tax_total/total ya calculados por create_credit_note_attempt),
 * sin volver a tocar clients/sales_order_items.
 *
 * Solo tiene sentido para una nota que la DIAN ya recibió de verdad --
 * 'sent'/'accepted' con CUDE real. Cualquier otro estado ('pending' de
 * paso, 'error', 'rejected') no es un documento fiscal, así que se rechaza
 * con un mensaje claro en vez de generar algo que aparente ser válido sin
 * serlo (mismo criterio que isRemision en sales-invoice-pdf). */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { buildInvoicePdf, invoiceDisplayLabel, type InvoicePdfBuyer, type InvoicePdfItem, type InvoicePdfSeller } from "../_shared/invoicing/buildInvoicePdf.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "content-type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "Missing Authorization header" }, 401);

  let body: { credit_note_id?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  if (!body.credit_note_id) return json({ error: "credit_note_id es requerido." }, 400);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const callerClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });

  const {
    data: { user: caller },
    error: callerError,
  } = await callerClient.auth.getUser();
  if (callerError || !caller) return json({ error: "Invalid session" }, 401);

  // RLS de sales_credit_notes ya aísla por tenant -- si es de otro tenant,
  // esto viene null, igual que "no existe".
  const { data: creditNote } = await callerClient
    .from("sales_credit_notes")
    .select(
      "id, tenant_id, invoice_id, status, status_detail, reason_description, credit_note_prefix, credit_note_number, currency, issue_date, cude, buyer_snapshot, seller_snapshot, tax_type_code, tax_rate, subtotal, tax_total, total, created_at",
    )
    .eq("id", body.credit_note_id)
    .maybeSingle();
  if (!creditNote) return json({ error: "Nota crédito no encontrada." }, 404);
  if (creditNote.status !== "sent" && creditNote.status !== "accepted") {
    return json({ error: `Esta nota crédito está en estado "${creditNote.status}" -- todavía no es un documento fiscal válido para generar su PDF.` }, 409);
  }
  if (!creditNote.cude || !creditNote.credit_note_prefix || creditNote.credit_note_number == null) {
    return json({ error: "A esta nota crédito le falta el CUDE o el número asignado -- no se puede generar el PDF." }, 409);
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey);

  const [{ data: invoice }, { data: tenant }, { data: credential }] = await Promise.all([
    adminClient.from("sales_invoices").select("invoice_prefix, invoice_number").eq("id", creditNote.invoice_id).maybeSingle(),
    adminClient.from("tenants").select("contact_email, contact_phone, logo_url").eq("id", creditNote.tenant_id).maybeSingle(),
    adminClient.from("integration_credentials").select("mode").eq("tenant_id", creditNote.tenant_id).eq("provider_key", "dian_directo").eq("is_active", true).is("deleted_at", null).maybeSingle(),
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

  try {
    const pdfBytes = await buildInvoicePdf({
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

    let binary = "";
    for (const b of pdfBytes) binary += String.fromCharCode(b);
    const pdfBase64 = btoa(binary);
    const filename = `${invoiceDisplayLabel(creditNote.credit_note_prefix, creditNote.credit_note_number, creditNote.credit_note_number)}.pdf`;

    return json({ pdf_base64: pdfBase64, filename });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
