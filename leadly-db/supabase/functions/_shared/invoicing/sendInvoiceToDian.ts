/** Envía una factura REAL (ya reservada por queueInvoiceGeneration al
 * confirmar una venta) a la DIAN -- a diferencia de sendToDian.ts (que
 * arma un documento sintético solo para probar la conexión), esto lee
 * sales_invoices/sales_invoice_items tal cual quedaron guardados y no
 * inventa ningún dato.
 *
 * Reusa exactamente el mismo pipeline ya verificado contra el servidor
 * real de habilitación: buildInvoiceXml (CUFE) -> signInvoiceXml (XAdES) ->
 * zip.ts -> wsSecuritySoap.ts (firma del sobre) -> mTLS fetch, formato SOAP
 * plano con el ZIP en base64 inline (ver sendToDian.ts para el porqué).
 *
 * Solo soporta SendTestSetAsync (habilitación) por ahora -- SendBillAsync
 * (producción) es la misma mecánica de transporte pero NUNCA se probó
 * contra el servidor real, así que queda explícitamente fuera hasta tener
 * al menos una factura de habilitación aceptada de punta a punta. */
import { buildInvoiceXml, type BuildInvoiceXmlInput, type InvoiceXmlLine } from "./buildInvoiceXml.ts";
import { signInvoiceXml } from "./signInvoiceXml.ts";
import { buildInvoiceZip } from "./zip.ts";
import { buildSignedSoapEnvelope } from "./wsSecuritySoap.ts";
import { resolveTenantIntegrationCredential, makeIntegrationSecretGetter } from "../integrations/credentials.ts";
import { loadTenantCertificate, createMtlsClient, uint8ToBase64 } from "./dianClient.ts";
import { refreshInvoiceSnapshot } from "./queueInvoiceGeneration.ts";

const PROVIDER_KEY = "dian_directo";

interface BuyerSnapshot {
  client_id: string | null;
  document_type_code: string | null;
  document_number: string | null;
  full_name: string | null;
  applies_withholding: boolean;
  address: { line1: string | null; line2: string | null; city: string | null; state_province: string | null; country: string | null } | null;
}
interface SellerSnapshot {
  legal_name: string | null;
  document_number: string | null;
  city: string | null;
  billing_address: string | null;
  country: string | null;
  state_province: string | null;
}

export interface SendInvoiceResult {
  status: "sent" | "error";
  httpStatus: number;
  cufe: string | null;
  dianTrackingId: string | null;
  faultReason: string | null;
  invoicePrefix: string;
  invoiceNumber: number;
}

/** Envía la factura `invoiceId` (fila de sales_invoices, status debe ser
 * 'pending') del tenant `tenantId`. Actualiza la fila con el resultado
 * (status/cufe/dian_tracking_id/dian_response/sent_at) antes de retornar,
 * tanto en éxito como en fault -- así "Facturas" siempre refleja el último
 * intento real, no queda desactualizada si el caller no vuelve a leer. */
// deno-lint-ignore no-explicit-any
export async function sendInvoiceToDian(adminClient: any, tenantId: string, invoiceId: string): Promise<SendInvoiceResult> {
  const { data: invoicePre, error: invoicePreError } = await adminClient
    .from("sales_invoices")
    .select("id, status, order_id")
    .eq("id", invoiceId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (invoicePreError || !invoicePre) throw new Error("Factura no encontrada.");
  if (invoicePre.status !== "pending") {
    throw new Error(`Esta factura está en estado "${invoicePre.status}", no "pending" -- para reintentar hay que crear un intento nuevo (ver retry_invoice en dian-submit).`);
  }

  // El snapshot se rearma con el pedido tal como está AHORA, justo antes de
  // construir el XML. El pedido sigue siendo editable después de confirmarse
  // (se bloquea recién cuando la DIAN lo acepta/recibe, ver dianLocksOrder en
  // OrderDetail.tsx), así que el snapshot congelado al confirmar podía estar
  // viejo: corregir un precio entre "confirmar" y "enviar" transmitía los
  // valores anteriores. Después de esto el pedido queda bloqueado, así que lo
  // enviado y lo que se ve en pantalla ya no pueden divergir.
  await refreshInvoiceSnapshot(adminClient, tenantId, invoiceId, invoicePre.order_id);

  const { data: invoice, error: invoiceError } = await adminClient
    .from("sales_invoices")
    .select("id, status, buyer_snapshot, seller_snapshot, subtotal, tax_total, total, currency")
    .eq("id", invoiceId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (invoiceError || !invoice) throw new Error("Factura no encontrada.");

  const { data: items, error: itemsError } = await adminClient
    .from("sales_invoice_items")
    .select("description:product_name, quantity, unit_price, subtotal, tax_type_code, tax_rate, tax_amount, taxable_base, display_order")
    .eq("invoice_id", invoiceId)
    .order("display_order");
  if (itemsError) throw new Error(itemsError.message);
  if (!items || items.length === 0) throw new Error("La factura no tiene ítems -- no se puede generar el XML.");

  const { data: profile, error: profileError } = await adminClient
    .from("tenant_dian_profile")
    .select("test_set_id, webservice_url, software_id, next_invoice_number, resolution_number, resolution_prefix, resolution_range_from, resolution_range_to, resolution_valid_from, resolution_valid_until")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (profileError || !profile) throw new Error("Este tenant no tiene perfil DIAN configurado.");
  if (!profile.test_set_id) throw new Error("Falta el Test Set ID en la configuración DIAN de este tenant.");
  if (!profile.webservice_url) throw new Error("Falta la URL del web service en la configuración DIAN de este tenant.");
  if (!profile.software_id) throw new Error("Falta el Software ID en la configuración DIAN de este tenant.");
  if (!profile.resolution_prefix || !profile.resolution_range_from) {
    throw new Error("Falta la resolución de facturación (prefijo/rango) en la configuración DIAN de este tenant.");
  }

  const credential = await resolveTenantIntegrationCredential(adminClient, tenantId, PROVIDER_KEY);
  const getSecret = makeIntegrationSecretGetter(adminClient, credential.id);
  const softwarePin = await getSecret("software_pin");
  const technicalKey = await getSecret("technical_key");
  if (!softwarePin) throw new Error("Falta el PIN del software en Integraciones.");
  if (!technicalKey) throw new Error("Falta la clave técnica en Integraciones.");

  const cert = await loadTenantCertificate(adminClient, tenantId);

  const buyer = invoice.buyer_snapshot as BuyerSnapshot;
  const seller = invoice.seller_snapshot as SellerSnapshot;
  if (!buyer.document_type_code || !buyer.document_number) throw new Error("El comprador no tiene documento fiscal completo.");
  if (!seller.legal_name || !seller.document_number) throw new Error("El vendedor (tenant) no tiene razón social/NIT completos.");

  const invoiceNumber = profile.next_invoice_number ?? profile.resolution_range_from;
  const invoicePrefix = profile.resolution_prefix;
  const invoiceDocId = `${invoicePrefix}${invoiceNumber}`;
  const now = new Date();

  const lines: InvoiceXmlLine[] = items.map((item: Record<string, unknown>, idx: number) => ({
    id: idx + 1,
    description: String(item.description ?? "Producto"),
    quantity: Number(item.quantity),
    unitPrice: Number(item.unit_price),
    lineExtensionAmount: Number(item.subtotal),
    tax: item.tax_type_code
      ? { code: String(item.tax_type_code), rate: Number(item.tax_rate), taxableAmount: Number(item.taxable_base), taxAmount: Number(item.tax_amount) }
      : null,
  }));

  const xmlInput: BuildInvoiceXmlInput = {
    invoiceId: invoiceDocId,
    issueDate: now.toISOString().slice(0, 10),
    issueTime: now.toISOString().slice(11, 19) + "-05:00",
    currency: invoice.currency ?? "COP",
    environment: 2,
    seller: {
      legalName: seller.legal_name,
      documentTypeCode: "31", // los tenants (empresas) que facturan son NIT prácticamente siempre -- ver nota en sendToDian.ts
      documentNumber: seller.document_number,
      addressLine: seller.billing_address ?? "N/A",
      city: seller.city ?? "N/A",
      stateProvince: seller.state_province ?? "N/A",
      countryCode: seller.country ?? "CO",
    },
    buyer: {
      legalName: buyer.full_name ?? "N/A",
      documentTypeCode: buyer.document_type_code,
      documentNumber: buyer.document_number,
      addressLine: buyer.address?.line1 ?? "N/A",
      city: buyer.address?.city ?? "N/A",
      stateProvince: buyer.address?.state_province ?? "N/A",
      countryCode: buyer.address?.country ?? "CO",
    },
    lines,
    withholdings: [], // el cálculo real de retenciones (tenant_withholding_configs + applies_withholding) es trabajo futuro, ver plan
    resolution: {
      number: profile.resolution_number ?? "",
      prefix: profile.resolution_prefix,
      rangeFrom: String(profile.resolution_range_from),
      rangeTo: String(profile.resolution_range_to ?? profile.resolution_range_from),
      validFrom: profile.resolution_valid_from ?? now.toISOString().slice(0, 10),
      validUntil: profile.resolution_valid_until ?? now.toISOString().slice(0, 10),
    },
    softwareId: profile.software_id,
    softwarePin,
    technicalKey,
    authorizationProviderNit: "800197268",
  };

  const { xml: unsignedXml, cufe } = await buildInvoiceXml(xmlInput);
  const signedInvoiceXml = await signInvoiceXml({ unsignedXml, privateKey: cert.privateKey, certificateDer: cert.certificateDer });

  const zipFileName = `${invoiceDocId}.zip`;
  const zipBytes = buildInvoiceZip([{ fileName: `${invoiceDocId}.xml`, content: new TextEncoder().encode(signedInvoiceXml) }]);
  const zipBase64 = uint8ToBase64(zipBytes);

  const bodyXml = `<wcf:SendTestSetAsync xmlns:wcf="http://wcf.dian.colombia"><wcf:fileName>${zipFileName}</wcf:fileName><wcf:contentFile>${zipBase64}</wcf:contentFile><wcf:testSetId>${profile.test_set_id}</wcf:testSetId></wcf:SendTestSetAsync>`;

  const envelope = await buildSignedSoapEnvelope({
    action: "http://wcf.dian.colombia/IWcfDianCustomerServices/SendTestSetAsync",
    to: profile.webservice_url,
    bodyXml,
    privateKey: cert.privateKey,
    certificateDer: cert.certificateDer,
  });

  const client = createMtlsClient(cert);
  let responseBody = "";
  let httpStatus = 0;
  try {
    const resp = await fetch(profile.webservice_url, {
      method: "POST",
      client,
      headers: {
        "Content-Type": "application/soap+xml; charset=utf-8",
        SOAPAction: '"http://wcf.dian.colombia/IWcfDianCustomerServices/SendTestSetAsync"',
      },
      body: envelope,
    });
    httpStatus = resp.status;
    responseBody = await resp.text();
  } finally {
    client.close?.();
  }

  const zipKeyMatch = responseBody.match(/<b:zipkey>([^<]+)<\/b:zipkey>/i);
  const faultMatch = responseBody.match(/<s:Text[^>]*>([^<]+)<\/s:Text>/);
  const zipKey = zipKeyMatch ? zipKeyMatch[1] : null;
  const faultReason = zipKey ? null : (faultMatch?.[1] ?? null);

  const nowIso = now.toISOString();
  if (zipKey) {
    await adminClient
      .from("sales_invoices")
      .update({
        status: "sent",
        status_detail: null,
        invoice_prefix: invoicePrefix,
        invoice_number: invoiceNumber,
        issue_date: nowIso,
        cufe,
        dian_tracking_id: zipKey,
        dian_response: { httpStatus, responseBody },
        sent_at: nowIso,
      })
      .eq("id", invoiceId);
    await adminClient
      .from("tenant_dian_profile")
      .update({ next_invoice_number: Number(invoiceNumber) + 1 })
      .eq("tenant_id", tenantId);
  } else {
    await adminClient
      .from("sales_invoices")
      .update({
        status: "error",
        status_detail: faultReason ?? `HTTP ${httpStatus}`,
        cufe,
        dian_response: { httpStatus, responseBody },
        sent_at: nowIso,
      })
      .eq("id", invoiceId);
  }

  return {
    status: zipKey ? "sent" : "error",
    httpStatus,
    cufe,
    dianTrackingId: zipKey,
    faultReason,
    invoicePrefix,
    invoiceNumber: Number(invoiceNumber),
  };
}
