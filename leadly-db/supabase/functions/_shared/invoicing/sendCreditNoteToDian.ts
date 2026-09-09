/** Envía una nota crédito REAL (ya reservada por create_credit_note_attempt,
 * ver la migración 20260909150000_sales_credit_notes.sql) a la DIAN --
 * mismo pipeline exacto que sendInvoiceToDian.ts: buildCreditNoteXml (CUDE)
 * -> signInvoiceXml (XAdES, genérico a cualquier UBL con el mismo hueco de
 * extensión) -> zip.ts -> wsSecuritySoap.ts -> mTLS fetch, SendTestSetAsync
 * (habilitación) -- SendBillAsync (producción) sigue fuera de alcance,
 * mismo motivo que en sendInvoiceToDian.ts. */
import { buildCreditNoteXml, type BuildCreditNoteXmlInput } from "./buildCreditNoteXml.ts";
import { signInvoiceXml } from "./signInvoiceXml.ts";
import { buildInvoiceZip } from "./zip.ts";
import { buildSignedSoapEnvelope } from "./wsSecuritySoap.ts";
import { resolveTenantIntegrationCredential, makeIntegrationSecretGetter } from "../integrations/credentials.ts";
import { loadTenantCertificate, createMtlsClient, uint8ToBase64 } from "./dianClient.ts";

const PROVIDER_KEY = "dian_directo";

interface BuyerSnapshot {
  document_type_code: string | null;
  document_number: string | null;
  full_name: string | null;
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

export interface SendCreditNoteResult {
  status: "sent" | "error";
  httpStatus: number;
  cude: string | null;
  dianTrackingId: string | null;
  faultReason: string | null;
  creditNotePrefix: string;
  creditNoteNumber: number;
}

/** Envía la nota crédito `creditNoteId` (fila de sales_credit_notes, status
 * debe ser 'pending', 'error' o 'rejected' -- este último cubre tanto el
 * primer envío como un reintento, ver retry_credit_note en dian-submit)
 * del tenant `tenantId`. Actualiza la fila con el resultado antes de
 * retornar, en éxito y en fault -- mismo criterio que sendInvoiceToDian.
 *
 * TODA la función (no solo el fetch final) corre dentro de un try/catch que
 * marca la fila como 'error' ante cualquier falla -- bug real encontrado en
 * vivo el 2026-09-09: faltaba configurar el prefijo de notas crédito, esa
 * validación lanzaba ANTES de llegar al bloque que ya tenía su propio
 * try/finally (solo alrededor del fetch), así que la fila quedaba en
 * 'pending' para siempre sin ningún mensaje ni forma de reintentar desde la
 * UI. */
// deno-lint-ignore no-explicit-any
export async function sendCreditNoteToDian(adminClient: any, tenantId: string, creditNoteId: string): Promise<SendCreditNoteResult> {
  const { data: creditNote, error: creditNoteError } = await adminClient
    .from("sales_credit_notes")
    .select("id, status, invoice_id, buyer_snapshot, seller_snapshot, reason_code, reason_description, tax_type_code, tax_rate, subtotal, tax_total, total, currency")
    .eq("id", creditNoteId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (creditNoteError || !creditNote) throw new Error("Nota crédito no encontrada.");
  if (creditNote.status !== "pending" && creditNote.status !== "error" && creditNote.status !== "rejected") {
    throw new Error(`Esta nota crédito está en estado "${creditNote.status}", no se puede (re)enviar.`);
  }

  try {
    return await doSendCreditNoteToDian(adminClient, tenantId, creditNoteId, creditNote);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await adminClient
      .from("sales_credit_notes")
      .update({ status: "error", status_detail: message })
      .eq("id", creditNoteId);
    throw err;
  }
}

// deno-lint-ignore no-explicit-any
async function doSendCreditNoteToDian(adminClient: any, tenantId: string, creditNoteId: string, creditNote: any): Promise<SendCreditNoteResult> {
  const { data: invoice, error: invoiceError } = await adminClient
    .from("sales_invoices")
    .select("invoice_prefix, invoice_number, cufe, issue_date, status")
    .eq("id", creditNote.invoice_id)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (invoiceError || !invoice) throw new Error("La factura referenciada por esta nota crédito ya no existe.");
  if (!invoice.cufe || !invoice.invoice_prefix || invoice.invoice_number == null) {
    throw new Error("La factura referenciada no tiene un CUFE/número real -- no se puede generar la nota crédito.");
  }

  const { data: profile, error: profileError } = await adminClient
    .from("tenant_dian_profile")
    .select("test_set_id, webservice_url, software_id, next_credit_note_number, credit_note_prefix")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (profileError || !profile) throw new Error("Este tenant no tiene perfil DIAN configurado.");
  if (!profile.test_set_id) throw new Error("Falta el Test Set ID en la configuración DIAN de este tenant.");
  if (!profile.webservice_url) throw new Error("Falta la URL del web service en la configuración DIAN de este tenant.");
  if (!profile.software_id) throw new Error("Falta el Software ID en la configuración DIAN de este tenant.");
  if (!profile.credit_note_prefix) {
    throw new Error("Falta configurar el prefijo de notas crédito en Integraciones > Facturación electrónica DIAN.");
  }

  const credential = await resolveTenantIntegrationCredential(adminClient, tenantId, PROVIDER_KEY);
  const getSecret = makeIntegrationSecretGetter(adminClient, credential.id);
  const softwarePin = await getSecret("software_pin");
  const technicalKey = await getSecret("technical_key"); // no se usa en el CUDE, sí en la firma WS-Security (mismo certificado)
  if (!softwarePin) throw new Error("Falta el PIN del software en Integraciones.");
  if (!technicalKey) throw new Error("Falta la clave técnica en Integraciones.");

  const cert = await loadTenantCertificate(adminClient, tenantId);

  const buyer = creditNote.buyer_snapshot as BuyerSnapshot;
  const seller = creditNote.seller_snapshot as SellerSnapshot;
  if (!buyer.document_type_code || !buyer.document_number) throw new Error("El comprador de la factura original no tiene documento fiscal completo.");
  if (!seller.legal_name || !seller.document_number) throw new Error("El vendedor (tenant) no tiene razón social/NIT completos.");

  const creditNoteNumber = profile.next_credit_note_number ?? 1;
  const creditNotePrefix = profile.credit_note_prefix;
  const creditNoteDocId = `${creditNotePrefix}${creditNoteNumber}`;
  const now = new Date();

  const xmlInput: BuildCreditNoteXmlInput = {
    creditNoteId: creditNoteDocId,
    issueDate: now.toISOString().slice(0, 10),
    issueTime: now.toISOString().slice(11, 19) + "-05:00",
    currency: creditNote.currency ?? "COP",
    environment: 2,
    seller: {
      legalName: seller.legal_name,
      documentTypeCode: "31",
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
    referencedInvoice: {
      id: `${invoice.invoice_prefix}${invoice.invoice_number}`,
      cufe: invoice.cufe,
      issueDate: (invoice.issue_date ?? now.toISOString()).slice(0, 10),
    },
    reasonCode: creditNote.reason_code,
    reasonDescription: creditNote.reason_description,
    line: {
      description: `Ajuste según nota crédito -- ${creditNote.reason_description}`,
      amount: creditNote.total,
      tax: creditNote.tax_type_code
        ? { code: creditNote.tax_type_code, rate: creditNote.tax_rate, taxableAmount: creditNote.subtotal, taxAmount: creditNote.tax_total }
        : null,
    },
    softwareId: profile.software_id,
    softwarePin,
    authorizationProviderNit: "800197268",
  };

  const { xml: unsignedXml, cude } = await buildCreditNoteXml(xmlInput);
  const signedXml = await signInvoiceXml({ unsignedXml, privateKey: cert.privateKey, certificateDer: cert.certificateDer });

  const zipFileName = `${creditNoteDocId}.zip`;
  const zipBytes = buildInvoiceZip([{ fileName: `${creditNoteDocId}.xml`, content: new TextEncoder().encode(signedXml) }]);
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
  const processedMessageMatch = responseBody.match(/<c:ProcessedMessage>([^<]+)<\/c:ProcessedMessage>/i);
  const zipKey = zipKeyMatch ? zipKeyMatch[1] : null;
  const faultReason = zipKey ? null : (faultMatch?.[1] ?? processedMessageMatch?.[1] ?? null);

  const nowIso = now.toISOString();
  if (zipKey) {
    await adminClient
      .from("sales_credit_notes")
      .update({
        status: "sent",
        status_detail: null,
        credit_note_prefix: creditNotePrefix,
        credit_note_number: creditNoteNumber,
        issue_date: nowIso,
        cude,
        dian_tracking_id: zipKey,
        dian_response: { httpStatus, responseBody },
        sent_at: nowIso,
      })
      .eq("id", creditNoteId);
    await adminClient
      .from("tenant_dian_profile")
      .update({ next_credit_note_number: Number(creditNoteNumber) + 1 })
      .eq("tenant_id", tenantId);
    // La factura original NUNCA cambia de estado acá, sin importar el
    // motivo (incluido "2 - Anulación de factura electrónica") -- una
    // factura DIAN no se anula, la nota crédito ES el mecanismo legal de
    // corrección y la factura original se queda sent/accepted para
    // siempre, como parte del historial de documentos emitidos del pedido
    // (ver 20260909220000_sales_invoices_no_voided_reissue_after_credit.sql,
    // que revierte un primer intento equivocado de esto mismo). Volver a
    // facturar el pedido una vez que la vigente quedó acreditada del todo
    // es responsabilidad del trigger guard_sales_invoice_live_attempt, no
    // de este código.
  } else {
    await adminClient
      .from("sales_credit_notes")
      .update({
        status: "error",
        status_detail: faultReason ?? `HTTP ${httpStatus}`,
        cude,
        dian_response: { httpStatus, responseBody },
        sent_at: nowIso,
      })
      .eq("id", creditNoteId);
  }

  return {
    status: zipKey ? "sent" : "error",
    httpStatus,
    cude,
    dianTrackingId: zipKey,
    faultReason,
    creditNotePrefix,
    creditNoteNumber: Number(creditNoteNumber),
  };
}
