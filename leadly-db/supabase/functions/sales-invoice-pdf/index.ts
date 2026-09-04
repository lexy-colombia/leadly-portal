/** Genera la representación gráfica (PDF) de una factura DIAN y la devuelve
 * en base64 -- ver buildInvoicePdf.ts para el porqué del layout. Pedido
 * explícito del usuario 2026-09-03: el CUFE solo no le sirve a nadie, tiene
 * que poder descargar/ver un PDF real.
 *
 * A diferencia de dian-submit (que firma y envía, acción con efecto fiscal
 * real, admin-only), esto es solo lectura/render -- cualquier miembro del
 * tenant puede verlo, mismo criterio que ver el propio pedido. No usa
 * nodeCompatShim/pkijs/xmldsigjs (nada de firma acá), function liviana y
 * separada a propósito.
 *
 * Se genera on-demand en cada llamada -- no se cachea en Storage, ver
 * comentario de cabecera en buildInvoicePdf.ts. */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { buildInvoicePdf, invoiceDisplayLabel, type InvoicePdfBuyer, type InvoicePdfItem, type InvoicePdfSeller } from "../_shared/invoicing/buildInvoicePdf.ts";

const PAYMENT_METHOD_LABEL: Record<string, string> = {
  efectivo: "Efectivo",
  transferencia: "Transferencia",
  tarjeta: "Tarjeta",
  credito: "Crédito",
  saldo_favor: "Saldo a favor",
  wompi: "Wompi",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "content-type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "Missing Authorization header" }, 401);

  let body: { order_id?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  if (!body.order_id) return json({ error: "order_id es requerido." }, 400);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const callerClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });

  const {
    data: { user: caller },
    error: callerError,
  } = await callerClient.auth.getUser();
  if (callerError || !caller) return json({ error: "Invalid session" }, 401);

  // RLS de sales_orders ya aísla por tenant -- si el pedido es de otro
  // tenant, esto viene null, igual que "no existe".
  const { data: order } = await callerClient
    .from("sales_orders")
    .select("id, tenant_id, number, created_at, subtotal, tax_total, total, currency, contact_id, billing_address_id")
    .eq("id", body.order_id)
    .maybeSingle();
  if (!order) return json({ error: "Pedido no encontrado." }, 404);

  const adminClient = createClient(supabaseUrl, serviceRoleKey);

  // TODO se lee EN VIVO del pedido, no de los snapshots de sales_invoices.
  // El snapshot existe para dejar registro de lo que se le transmitió a la
  // DIAN (lo firma el CUFE), pero como fuente del PDF quedaba desfasado: el
  // pedido sigue siendo editable después de confirmarse, y el usuario espera
  // ver "lo que tengo en pantalla" (pedido explícito 2026-09-04). El envío a
  // la DIAN ahora rearma ese snapshot justo antes de transmitir (ver
  // refreshInvoiceSnapshot), y desde ese momento el pedido queda bloqueado,
  // así que PDF y documento fiscal no pueden divergir.
  //
  // De la factura solo salen los datos que NO existen en el pedido: el
  // consecutivo DIAN, el CUFE y el estado.
  const [{ data: items }, { data: client }, { data: address }, { data: tenant }, { data: dianProfile }, { data: credential }, { data: lastPayment }, { data: comments }, { data: invoice }] = await Promise.all([
    adminClient.from("sales_order_items").select("*").eq("order_id", order.id).order("display_order"),
    adminClient.from("clients").select("full_name, email, phone, document_number, dian_document_type_code").eq("id", order.contact_id).maybeSingle(),
    order.billing_address_id
      ? adminClient.from("contact_addresses").select("line1, line2, city, state_province, country").eq("id", order.billing_address_id).maybeSingle()
      : Promise.resolve({ data: null }),
    adminClient.from("tenants").select("legal_name, document_type, document_number, country, state_province, billing_address, contact_email, contact_phone, logo_url").eq("id", order.tenant_id).maybeSingle(),
    adminClient.from("tenant_dian_profile").select("fiscal_regime, is_self_withholding_agent, city, resolution_number, resolution_prefix, resolution_range_from, resolution_range_to, resolution_valid_from, resolution_valid_until").eq("tenant_id", order.tenant_id).maybeSingle(),
    adminClient.from("integration_credentials").select("mode").eq("tenant_id", order.tenant_id).eq("provider_key", "dian_directo").eq("is_active", true).is("deleted_at", null).maybeSingle(),
    adminClient.from("sales_order_payments").select("method, paid_at").eq("order_id", order.id).order("paid_at", { ascending: false }).limit(1).maybeSingle(),
    // Solo el hilo público -- `is_internal = true` son las "Notas" del
    // equipo, que no se imprimen.
    adminClient.from("sales_order_comments").select("content").eq("order_id", order.id).eq("is_internal", false).order("created_at"),
    adminClient.from("sales_invoices").select("status, status_detail, invoice_prefix, invoice_number, issue_date, cufe, withholding_total").eq("order_id", order.id).order("attempt_number", { ascending: false }).limit(1).maybeSingle(),
  ]);

  // Remisión: el tenant no tiene facturación electrónica DIAN, así que este
  // pedido nunca generó una fila de sales_invoices (queueInvoiceGeneration
  // sale temprano sin credencial activa). Mismo diseño, sin resolución, sin
  // CUFE y sin QR, y numerado REM-<pedido>.
  const isRemision = !invoice;

  const buyer: InvoicePdfBuyer = {
    full_name: client?.full_name ?? null,
    document_type_code: client?.dian_document_type_code ?? null,
    document_number: client?.document_number ?? null,
    phone: client?.phone ?? null,
    email: client?.email ?? null,
    address: address ?? null,
  };
  const seller: InvoicePdfSeller = {
    legal_name: tenant?.legal_name ?? null,
    document_type: tenant?.document_type ?? null,
    document_number: tenant?.document_number ?? null,
    city: dianProfile?.city ?? null,
    billing_address: tenant?.billing_address ?? null,
    country: tenant?.country ?? null,
    state_province: tenant?.state_province ?? null,
    fiscal_regime: isRemision ? null : (dianProfile?.fiscal_regime ?? null),
    is_self_withholding_agent: !isRemision && Boolean(dianProfile?.is_self_withholding_agent),
    resolution: isRemision || !dianProfile
      ? null
      : {
        number: dianProfile.resolution_number,
        prefix: dianProfile.resolution_prefix,
        range_from: dianProfile.resolution_range_from,
        range_to: dianProfile.resolution_range_to,
        valid_from: dianProfile.resolution_valid_from,
        valid_until: dianProfile.resolution_valid_until,
      },
    contact_email: tenant?.contact_email ?? null,
    contact_phone: tenant?.contact_phone ?? null,
  };

  const pdfItems: InvoicePdfItem[] = (items ?? []).map((i) => ({
    product_name: i.product_name,
    sku: i.sku,
    quantity: i.quantity,
    unit_price: i.unit_price,
    subtotal: i.subtotal,
    tax_type_code: i.tax_type_code,
    tax_rate: i.tax_rate,
    tax_amount: i.tax_amount,
  }));

  const qrHost = credential?.mode === "production" ? "catalogo-vpfe.dian.gov.co" : "catalogo-vpfe-hab.dian.gov.co";
  const qrVerificationUrl = !isRemision && invoice?.cufe ? `https://${qrHost}/document/searchqr?documentkey=${invoice.cufe}` : null;

  // El logo es público (bucket tenant-logos) -- un fetch simple alcanza, sin
  // admin client. Nunca bloquea la generación del PDF: si el tenant no
  // cargó uno, o la descarga falla por lo que sea, el PDF sale sin logo.
  let logoBytes: Uint8Array | null = null;
  if (tenant?.logo_url) {
    try {
      const logoRes = await fetch(tenant.logo_url);
      if (logoRes.ok) logoBytes = new Uint8Array(await logoRes.arrayBuffer());
    } catch {
      logoBytes = null;
    }
  }

  // "REM" en una remisión; en una factura, el prefijo de la resolución (el
  // guardado en la factura si ya se numeró, si no el vigente del perfil).
  const displayPrefix = isRemision ? "REM" : (invoice?.invoice_prefix ?? seller.resolution?.prefix ?? null);

  try {
    const pdfBytes = await buildInvoicePdf({
      isRemision,
      status: invoice?.status ?? "draft",
      statusDetail: invoice?.status_detail ?? null,
      invoicePrefix: displayPrefix,
      invoiceNumber: isRemision ? null : (invoice?.invoice_number ?? null),
      issueDate: invoice?.issue_date ?? null,
      cufe: isRemision ? null : (invoice?.cufe ?? null),
      // Totales del PEDIDO, no de la factura -- son lo que el usuario ve en
      // pantalla, y desde el envío a la DIAN quedan congelados por el bloqueo.
      currency: order.currency,
      subtotal: order.subtotal,
      taxTotal: order.tax_total,
      withholdingTotal: invoice?.withholding_total ?? 0,
      total: order.total,
      buyer,
      seller,
      items: pdfItems,
      orderNumber: order.number,
      orderCreatedAt: order.created_at,
      paymentMethodLabel: lastPayment?.method ? (PAYMENT_METHOD_LABEL[lastPayment.method] ?? lastPayment.method) : null,
      qrVerificationUrl,
      notes: (comments ?? []).map((c) => c.content as string).filter((c) => c.trim().length > 0),
      logoBytes,
    });

    let binary = "";
    for (const b of pdfBytes) binary += String.fromCharCode(b);
    const pdfBase64 = btoa(binary);

    // Mismo identificador que se ve en el header del PDF ("POS-3393",
    // "REM-42") -- pedido explícito del usuario: el nombre del archivo debe
    // ser "tal cual como está el header de esta factura".
    const filename = `${invoiceDisplayLabel(displayPrefix, isRemision ? null : (invoice?.invoice_number ?? null), order.number)}.pdf`;

    return json({ pdf_base64: pdfBase64, filename });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
