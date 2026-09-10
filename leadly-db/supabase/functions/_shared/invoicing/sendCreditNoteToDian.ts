/** Envía una nota crédito REAL (ya reservada por create_credit_note_attempt,
 * ver la migración 20260909150000_sales_credit_notes.sql) a la DIAN --
 * mismo pipeline exacto que sendInvoiceToDian.ts: buildCreditNoteXml (CUDE)
 * -> signInvoiceXml (XAdES, genérico a cualquier UBL con el mismo hueco de
 * extensión) -> zip.ts -> wsSecuritySoap.ts -> mTLS fetch. Mismos DOS
 * ambientes que sendInvoiceToDian.ts (ver ese archivo para el porqué
 * completo): `SendTestSetAsync` en habilitación (asíncrona, ZipKey +
 * polling) y `SendBillSync` en producción (síncrona, veredicto en la misma
 * respuesta) -- `SendBillAsync` es el método de envío POR LOTES, que la
 * DIAN rechaza sin una autorización de cuenta aparte que no tenemos. */
import { buildCreditNoteXml, type BuildCreditNoteXmlInput } from "./buildCreditNoteXml.ts";
import { signInvoiceXml } from "./signInvoiceXml.ts";
import { buildInvoiceZip } from "./zip.ts";
import { buildSignedSoapEnvelope } from "./wsSecuritySoap.ts";
import { resolveTenantIntegrationCredential, makeIntegrationSecretGetter } from "../integrations/credentials.ts";
import { loadTenantCertificate, createMtlsClient, uint8ToBase64 } from "./dianClient.ts";
import { pollDianTrackStatus, parseOneStatus } from "./getDianStatus.ts";
import { interpretDianStatus, applyCreditNoteVerdict } from "./applyDianVerdict.ts";
import { colombiaIssueMoment } from "./colombiaTime.ts";
import { storeSignedXml } from "./storeSignedXml.ts";

const PROVIDER_KEY = "dian_directo";

interface BuyerSnapshot {
  document_type_code: string | null;
  document_number: string | null;
  full_name: string | null;
  applies_withholding?: boolean;
  /** Correo del cliente -- ya viene en el snapshot desde
   * queueInvoiceGeneration.ts. Lo exige la regla CAK55 de la NOTA CRÉDITO
   * (en la factura el correo obligatorio es el del emisor, FAJ71; acá es
   * también el del comprador). */
  email?: string | null;
  address: {
    line1: string | null;
    line2: string | null;
    city: string | null;
    state_province: string | null;
    country: string | null;
    city_code?: string | null;
    state_code?: string | null;
  } | null;
}
interface SellerSnapshot {
  legal_name: string | null;
  document_number: string | null;
  city: string | null;
  city_code?: string | null;
  state_code?: string | null;
  billing_address: string | null;
  country: string | null;
  state_province: string | null;
  is_self_withholding_agent?: boolean;
  /** Ver buildInvoiceXml.ts (regla FAJ71) -- copiado tal cual del
   * seller_snapshot de la factura referenciada. */
  contact_email?: string | null;
}

export interface SendCreditNoteResult {
  /** Mismo criterio que SendInvoiceResult (ver sendInvoiceToDian.ts) --
   * `accepted`/`rejected` ya son el veredicto real, resuelto dentro de esta
   * misma llamada. */
  status: "accepted" | "rejected" | "sent" | "error";
  httpStatus: number;
  cude: string | null;
  dianTrackingId: string | null;
  faultReason: string | null;
  rejectionDetail: string | null;
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
    .select("invoice_prefix, invoice_number, cufe, issue_date, status, order_id")
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
  if (!profile.webservice_url) throw new Error("Falta la URL del web service en la configuración DIAN de este tenant.");
  if (!profile.software_id) throw new Error("Falta el Software ID en la configuración DIAN de este tenant.");
  if (!profile.credit_note_prefix) {
    throw new Error("Falta configurar el prefijo de notas crédito en Integraciones > Facturación electrónica DIAN.");
  }

  const credential = await resolveTenantIntegrationCredential(adminClient, tenantId, PROVIDER_KEY);
  // Mismo criterio que sendInvoiceToDian.ts -- el ambiente sale del selector
  // "Modo" de Integraciones, y el Test Set ID solo aplica en habilitación.
  const isProduction = credential.mode === "production";
  if (!isProduction && !profile.test_set_id) throw new Error("Falta el Test Set ID en la configuración DIAN de este tenant.");
  const getSecret = makeIntegrationSecretGetter(adminClient, credential.id);
  const softwarePin = await getSecret("software_pin");
  if (!softwarePin) throw new Error("Falta el PIN del software en Integraciones.");
  // La clave técnica NO se lee acá a propósito. El CUDE de una nota crédito
  // usa el Software-PIN en su lugar (Anexo Técnico v1.9, numeral 11.4), y la
  // firma del sobre WS-Security usa el certificado, no la clave -- el
  // comentario anterior afirmaba lo contrario y era falso. Exigirla dejaba
  // sin poder emitir notas crédito a un tenant al que solo le faltara un
  // dato que este camino nunca usa.

  const cert = await loadTenantCertificate(adminClient, tenantId);

  const buyer = creditNote.buyer_snapshot as BuyerSnapshot;
  const seller = creditNote.seller_snapshot as SellerSnapshot;
  if (!buyer.document_type_code || !buyer.document_number) throw new Error("El comprador de la factura original no tiene documento fiscal completo.");
  if (!seller.legal_name || !seller.document_number) throw new Error("El vendedor (tenant) no tiene razón social/NIT completos.");
  // NO se bloquea por falta de dirección/código DANE -- ver el mismo
  // comentario en sendInvoiceToDian.ts (probado en vivo 2026-09-10).

  const creditNoteNumber = profile.next_credit_note_number ?? 1;
  const creditNotePrefix = profile.credit_note_prefix;
  const creditNoteDocId = `${creditNotePrefix}${creditNoteNumber}`;
  const now = new Date();

  // cac:PaymentMeans (CAN01, grupo obligatorio) -- mismo criterio y mismo
  // catálogo UNCL4461 que sendInvoiceToDian.ts: se refleja el pago REAL de
  // la venta que esta nota corrige, nunca un valor inventado. Nota sobre
  // CAN04: con "2" (crédito) la DIAN exige PaymentDueDate, un dato que
  // esta plataforma no guarda por pago -- por eso una venta a crédito se
  // informa igual como "1" (contado) acá; la nota crédito no es el
  // documento que fija el plazo de pago de nada, y mandar "2" sin la fecha
  // sería un rechazo seguro.
  const { data: latestPayment } = await adminClient
    .from("sales_order_payments")
    .select("method")
    .eq("order_id", invoice.order_id)
    .is("deleted_at", null)
    .order("paid_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const PAYMENT_MEANS_CODE: Record<string, string> = {
    efectivo: "10",
    transferencia: "42",
    wompi: "42",
    tarjeta: "48",
  };
  const paymentMethod = latestPayment?.method ?? null;
  // Hora REAL de Colombia -- ver colombiaTime.ts.
  const { issueDate, issueTime } = colombiaIssueMoment(now);

  const xmlInput: BuildCreditNoteXmlInput = {
    creditNoteId: creditNoteDocId,
    issueDate,
    issueTime,
    currency: creditNote.currency ?? "COP",
    environment: isProduction ? 1 : 2,
    seller: {
      legalName: seller.legal_name,
      documentTypeCode: "31",
      documentNumber: seller.document_number,
      addressLine: seller.billing_address ?? null,
      city: seller.city ?? null,
      stateProvince: seller.state_province ?? null,
      countryCode: seller.country ?? "CO",
      cityCode: seller.city_code ?? null,
      stateCode: seller.state_code ?? null,
      taxLevelCode: seller.is_self_withholding_agent ? "O-15" : "R-99-PN",
      electronicMail: seller.contact_email ?? null,
    },
    buyer: {
      legalName: buyer.full_name ?? "N/A",
      documentTypeCode: buyer.document_type_code,
      documentNumber: buyer.document_number,
      addressLine: buyer.address?.line1 ?? null,
      city: buyer.address?.city ?? null,
      stateProvince: buyer.address?.state_province ?? null,
      countryCode: buyer.address?.country ?? "CO",
      cityCode: buyer.address?.city_code ?? null,
      stateCode: buyer.address?.state_code ?? null,
      taxLevelCode: buyer.applies_withholding ? "O-15" : "R-99-PN",
      electronicMail: buyer.email ?? null,
    },
    referencedInvoice: {
      id: `${invoice.invoice_prefix}${invoice.invoice_number}`,
      cufe: invoice.cufe,
      issueDate: invoice.issue_date ? String(invoice.issue_date).slice(0, 10) : issueDate,
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
    payment: {
      meansId: "1",
      meansCode: (paymentMethod && PAYMENT_MEANS_CODE[paymentMethod]) || "1",
    },
    softwareId: profile.software_id,
    softwarePin,
    authorizationProviderNit: "800197268",
  };

  // ⚠️ ACÁ NO VA la validación de tarifas de taxRates.ts que sí corre en
  // sendInvoiceToDian.ts, y es a propósito: una nota crédito tiene que
  // declarar EL MISMO impuesto que el documento que corrige, aunque esa
  // combinación tipo+tarifa sea inválida -- si no, no cuadra contra la
  // factura que anula. Caso real que lo obligó (Barriles de la sexta,
  // 2026-09-10): la factura FE-13 quedó ACEPTADA declarando INC al 19%
  // (FAX14 es notificación, no rechazo, así que pasó igual), y la única
  // forma de corregirla es una nota crédito que también diga INC 19%.
  // Bloquearla acá dejaría al tenant sin manera de arreglar una factura
  // ya emitida -- peor que la notificación que la validación evita.
  const { xml: unsignedXml, cude } = await buildCreditNoteXml(xmlInput);
  const signedXml = await signInvoiceXml({ unsignedXml, privateKey: cert.privateKey, certificateDer: cert.certificateDer });
  // Misma conservación que la factura -- ver storeSignedXml.ts.
  await storeSignedXml(adminClient, {
    tenantId,
    table: "sales_credit_notes",
    rowId: creditNoteId,
    documentName: creditNoteDocId,
    xml: signedXml,
  });


  const zipFileName = `${creditNoteDocId}.zip`;
  const zipBytes = buildInvoiceZip([{ fileName: `${creditNoteDocId}.xml`, content: new TextEncoder().encode(signedXml) }]);
  const zipBase64 = uint8ToBase64(zipBytes);

  // Ver sendInvoiceToDian.ts -- producción usa SendBillSync (individual,
  // sin testSetId), no SendBillAsync (esa es la operación de envío por
  // lotes, exige una autorización de cuenta aparte que no tenemos).
  const operation = isProduction ? "SendBillSync" : "SendTestSetAsync";
  const soapAction = `http://wcf.dian.colombia/IWcfDianCustomerServices/${operation}`;
  const bodyXml = isProduction
    ? `<wcf:SendBillSync xmlns:wcf="http://wcf.dian.colombia"><wcf:fileName>${zipFileName}</wcf:fileName><wcf:contentFile>${zipBase64}</wcf:contentFile></wcf:SendBillSync>`
    : `<wcf:SendTestSetAsync xmlns:wcf="http://wcf.dian.colombia"><wcf:fileName>${zipFileName}</wcf:fileName><wcf:contentFile>${zipBase64}</wcf:contentFile><wcf:testSetId>${profile.test_set_id}</wcf:testSetId></wcf:SendTestSetAsync>`;

  const envelope = await buildSignedSoapEnvelope({
    action: soapAction,
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
        SOAPAction: `"${soapAction}"`,
      },
      body: envelope,
    });
    httpStatus = resp.status;
    responseBody = await resp.text();
  } finally {
    client.close?.();
  }

  const nowIso = now.toISOString();

  // SendBillSync (producción) es síncrona -- mismo criterio que
  // sendInvoiceToDian.ts: el veredicto ya viene en esta respuesta, sin
  // ZipKey y sin polling posterior.
  if (isProduction) {
    const faultMatch = responseBody.match(/<s:Text[^>]*>([^<]+)<\/s:Text>/) ?? responseBody.match(/<faultstring[^>]*>([^<]+)<\/faultstring>/i);
    const parsed = faultMatch ? null : parseOneStatus(responseBody);
    if (!parsed || parsed.isValid === null) {
      const faultReason = faultMatch?.[1] ?? "La DIAN no devolvió un veredicto reconocible.";
      await adminClient
        .from("sales_credit_notes")
        .update({ status: "error", status_detail: faultReason, cude, dian_response: { httpStatus, responseBody }, sent_at: nowIso })
        .eq("id", creditNoteId);
      return { status: "error", httpStatus, cude, dianTrackingId: null, faultReason, rejectionDetail: null, creditNotePrefix, creditNoteNumber: Number(creditNoteNumber) };
    }

    const { error: markSentError } = await adminClient
      .from("sales_credit_notes")
      .update({
        status: "sent",
        status_detail: null,
        credit_note_prefix: creditNotePrefix,
        credit_note_number: creditNoteNumber,
        issue_date: nowIso,
        cude,
        dian_tracking_id: parsed.xmlDocumentKey,
        dian_response: { httpStatus, responseBody },
        sent_at: nowIso,
      })
      .eq("id", creditNoteId);
    if (markSentError) {
      throw new Error(`La DIAN validó la nota crédito pero no se pudo guardar el resultado: ${markSentError.message}`);
    }

    const verdict = interpretDianStatus(parsed);
    await applyCreditNoteVerdict(adminClient, tenantId, creditNoteId, Number(creditNoteNumber), verdict);

    return {
      status: verdict.outcome === "accepted" ? "accepted" : verdict.outcome === "rejected" ? "rejected" : "sent",
      httpStatus,
      cude,
      dianTrackingId: parsed.xmlDocumentKey,
      faultReason: null,
      rejectionDetail: verdict.outcome === "rejected" ? verdict.detail : null,
      creditNotePrefix,
      creditNoteNumber: Number(creditNoteNumber),
    };
  }

  // A partir de acá: habilitación (SendTestSetAsync), asíncrona -- sin
  // cambios respecto a antes.
  const zipKeyMatch = responseBody.match(/<b:zipkey>([^<]+)<\/b:zipkey>/i);
  const faultMatch = responseBody.match(/<s:Text[^>]*>([^<]+)<\/s:Text>/);
  const processedMessageMatch = responseBody.match(/<c:ProcessedMessage>([^<]+)<\/c:ProcessedMessage>/i);
  const zipKey = zipKeyMatch ? zipKeyMatch[1] : null;
  const faultReason = zipKey ? null : (faultMatch?.[1] ?? processedMessageMatch?.[1] ?? null);

  if (!zipKey) {
    // Falló el envío en sí -- el consecutivo (next_credit_note_number) NO
    // se toca, mismo criterio que sendInvoiceToDian.ts.
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
    return { status: "error", httpStatus, cude, dianTrackingId: null, faultReason, rejectionDetail: null, creditNotePrefix, creditNoteNumber: Number(creditNoteNumber) };
  }

  // Mismo bug real que sendInvoiceToDian.ts (ver ese archivo, 2026-09-10):
  // este UPDATE puede fallar (ej. choque contra el índice único de
  // credit_note_number, migración 20260910040000) y hay que enterarse antes
  // de seguir al polling con un estado que nunca se pudo guardar.
  const { error: markSentError } = await adminClient
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
  if (markSentError) {
    throw new Error(`La DIAN recibió la nota crédito (zipKey ${zipKey}) pero no se pudo guardar el resultado: ${markSentError.message}`);
  }
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

  // Mismo criterio que sendInvoiceToDian.ts -- este endpoint verifica el
  // veredicto real antes de devolver, en vez de dejarlo en 'sent' a la
  // espera de un "Verificar estado" manual.
  const polled = await pollDianTrackStatus(adminClient, tenantId, zipKey);
  const verdict = interpretDianStatus(polled.statuses[0] ?? null);
  await applyCreditNoteVerdict(adminClient, tenantId, creditNoteId, Number(creditNoteNumber), verdict);

  return {
    status: verdict.outcome === "accepted" ? "accepted" : verdict.outcome === "rejected" ? "rejected" : "sent",
    httpStatus,
    cude,
    dianTrackingId: zipKey,
    faultReason: null,
    rejectionDetail: verdict.outcome === "rejected" ? verdict.detail : null,
    creditNotePrefix,
    creditNoteNumber: Number(creditNoteNumber),
  };
}
