/** Armado de la representación gráfica (PDF) de un pedido facturado.
 *
 * Extraído de `sales-invoice-pdf/index.ts` el 2026-09-10, sin cambiar
 * NADA del criterio original (ver los comentarios largos abajo, que vienen
 * tal cual de ahí). El motivo de la extracción: la entrega por correo al
 * adquiriente necesita exactamente el mismo PDF que el botón "Descargar",
 * y duplicar este armado -- que decide, entre otras cosas, si el documento
 * es factura o remisión -- garantizaba que las dos copias se desincronizaran
 * a la primera corrección. Ahora hay un solo lugar donde se decide qué dice
 * el papel.
 *
 * Toma un `adminClient` a propósito: es un render de solo lectura y el
 * aislamiento por tenant ya lo hizo quien llama (el endpoint verifica el
 * pedido con el JWT del usuario antes de delegar; el envío por correo sale
 * de una factura que ya se resolvió por tenant). */
import { buildInvoicePdf, invoiceDisplayLabel, type InvoicePdfBuyer, type InvoicePdfItem, type InvoicePdfSeller } from "./buildInvoicePdf.ts";

const PAYMENT_METHOD_LABEL: Record<string, string> = {
  efectivo: "Efectivo",
  transferencia: "Transferencia",
  tarjeta: "Tarjeta",
  credito: "Crédito",
  saldo_favor: "Saldo a favor",
  wompi: "Wompi",
};

export interface RenderedInvoicePdf {
  bytes: Uint8Array;
  /** Mismo identificador que se ve en el header del PDF ("POS-3393",
   * "REM-42") -- pedido explícito del usuario: el nombre del archivo debe
   * ser "tal cual como está el header de esta factura". */
  filename: string;
  /** `true` cuando el documento NO es una factura validada por la DIAN
   * (ver `isRemision` abajo). El correo de entrega lo usa para no
   * prometer un documento fiscal que no existe. */
  isRemision: boolean;
}

/** Renderiza el PDF del pedido `orderId`. Lanza si el pedido no existe. */
// deno-lint-ignore no-explicit-any
export async function renderInvoicePdfForOrder(adminClient: any, orderId: string): Promise<RenderedInvoicePdf> {
  const { data: order } = await adminClient
    .from("sales_orders")
    .select("id, tenant_id, number, created_at, subtotal, tax_total, total, currency, contact_id, billing_address_id")
    .eq("id", orderId)
    .maybeSingle();
  if (!order) throw new Error("Pedido no encontrado.");

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

  // CORREGIDO 2026-09-05 -- error grave reportado por el usuario: antes
  // alcanzaba con que existiera CUALQUIER fila de sales_invoices (sin
  // importar su estado) para mostrar el título "Factura Electrónica de
  // Venta" + la resolución DIAN + un número de documento. Una factura en
  // 'pending'/'generating'/'sending'/'rejected'/'error' salía con pinta de
  // documento fiscal real (resolución + numeración autorizada) pero sin
  // CUFE ni QR -- aparentar un comprobante que legalmente no existe.
  // `isRemision` ahora exige la prueba concreta de que la DIAN aceptó ESTE
  // envío puntual: `sent`/`accepted` Y CUFE real Y `invoice_number` real
  // (los tres solo se escriben juntos, y solo al confirmar la DIAN la
  // recepción, ver sendInvoiceToDian.ts). Cualquier otro estado -- incluido
  // "el tenant factura electrónico pero este pedido todavía no se envió o
  // fue rechazado" -- es remisión sin excepción: sin resolución, sin CUFE,
  // sin QR, numerada con el pedido (REM-<pedido>).
  const isValidated = invoice?.status === "sent" || invoice?.status === "accepted";
  const isRemision = !(invoice && isValidated && invoice.cufe && invoice.invoice_number != null);

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

  // deno-lint-ignore no-explicit-any
  const pdfItems: InvoicePdfItem[] = (items ?? []).map((i: any) => ({
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

  // "REM" en una remisión; en una factura real (isRemision ya exige que
  // invoice_prefix/invoice_number se hayan escrito juntos al validarse, ver
  // arriba), siempre el prefijo real que asignó sendInvoiceToDian.ts.
  const displayPrefix = isRemision ? "REM" : invoice?.invoice_prefix ?? null;

  const bytes = await buildInvoicePdf({
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
    // deno-lint-ignore no-explicit-any
    notes: (comments ?? []).map((c: any) => c.content as string).filter((c: string) => c.trim().length > 0),
    logoBytes,
  });

  const filename = `${invoiceDisplayLabel(displayPrefix, isRemision ? null : (invoice?.invoice_number ?? null), order.number)}.pdf`;
  return { bytes, filename, isRemision };
}

/** Base64 de un `Uint8Array`, en trozos para no reventar la pila con
 * `String.fromCharCode(...bytes)` sobre un PDF grande (el spread de un
 * array de decenas de miles de elementos tira "Maximum call stack size
 * exceeded"). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
