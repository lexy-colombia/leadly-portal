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
 * Soporta los DOS ambientes, según `integration_credentials.mode` -- el
 * mismo selector "Modo" que ya tiene toda tarjeta de Integraciones,
 * rotulado acá "Habilitación (pruebas)" / "Producción". No hay ninguna
 * columna `environment` en `tenant_dian_profile` (una versión anterior de
 * este comentario la nombraba; nunca existió):
 * - `habilitacion`: `SendTestSetAsync` + `testSetId` + ProfileExecutionID=2.
 *   Verificado de punta a punta el 2026-09-10 (factura SETP990000001 de
 *   Barriles de la sexta, "Procesado Correctamente"). Es ASÍNCRONA: la
 *   respuesta solo trae un acuse (`ZipKey`), el veredicto real se consulta
 *   después con `GetStatusZip` (`pollDianTrackStatus`, ver getDianStatus.ts).
 * - `produccion`: `SendBillSync` + ProfileExecutionID=1.
 *   ⚠️ Bug real corregido 2026-09-10: el primer intento usó `SendBillAsync`,
 *   que la DIAN rechazó con "Empresa emisora ... no se encuentra autorizada
 *   para enviar documentos por los lotes" -- `SendBillAsync` es el método de
 *   envío POR LOTES del Anexo Técnico (numeral 7.1), que exige una
 *   autorización de cuenta aparte que ningún tenant nuestro tiene ni
 *   necesita. Para una factura individual en producción el método correcto
 *   es `SendBillSync`: mismos parámetros de request (`fileName`+
 *   `contentFile`, sin `testSetId`), pero es SÍNCRONA -- el veredicto
 *   (`IsValid`/`StatusCode`/`ErrorMessage`/...) viene en la misma respuesta,
 *   sin `ZipKey` y sin necesidad de `GetStatusZip` después (se parsea con
 *   `parseOneStatus`, el mismo parser que usa el camino de habilitación).
 *   Confirmado contra el WSDL público de producción
 *   (https://vpfe.dian.gov.co/WcfDianCustomerServices.svc?singleWsdl,
 *   2026-09-10). VERIFICADO contra el servidor real de producción el
 *   2026-09-10: factura FE12 de Barriles de la sexta, "Procesado
 *   Correctamente" con CUFE real. Exige que el tenant haya cargado su
 *   resolución de facturación REAL (la de habilitación, prefijo SETP /
 *   rango 990000000, no es válida en producción) y, sobre todo, que la
 *   clave técnica sea la de ESE rango -- ver resolveTechnicalKey.ts, que
 *   la resuelve sola contra la DIAN justamente porque usar la de
 *   habilitación produce un FAD06 indescifrable. */
import { buildInvoiceXml, type BuildInvoiceXmlInput, type InvoiceXmlLine } from "./buildInvoiceXml.ts";
import { signInvoiceXml } from "./signInvoiceXml.ts";
import { buildInvoiceZip } from "./zip.ts";
import { buildSignedSoapEnvelope } from "./wsSecuritySoap.ts";
import { resolveTenantIntegrationCredential, makeIntegrationSecretGetter } from "../integrations/credentials.ts";
import { loadTenantCertificate, createMtlsClient, uint8ToBase64 } from "./dianClient.ts";
import { refreshInvoiceSnapshot } from "./queueInvoiceGeneration.ts";
import { pollDianTrackStatus, parseOneStatus } from "./getDianStatus.ts";
import { interpretDianStatus, applyInvoiceVerdict } from "./applyDianVerdict.ts";
import { resolveTechnicalKey } from "./resolveTechnicalKey.ts";
import { colombiaIssueMoment } from "./colombiaTime.ts";
import { storeSignedXml } from "./storeSignedXml.ts";

const PROVIDER_KEY = "dian_directo";

interface BuyerSnapshot {
  client_id: string | null;
  document_type_code: string | null;
  document_number: string | null;
  full_name: string | null;
  applies_withholding: boolean;
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
  /** Correo de contacto real del tenant -- ver buildInvoiceXml.ts (regla
   * FAJ71, cac:Contact/cbc:ElectronicMail del emisor). */
  contact_email?: string | null;
}

export interface SendInvoiceResult {
  /** `accepted`/`rejected`: veredicto REAL ya confirmado por la DIAN, resuelto
   * dentro de esta misma llamada (ver el polling más abajo) -- pedido
   * explícito del usuario 2026-09-09: "el endpoint debe verificar el estado
   * y devolverme si hubo error o no", para no depender de un botón aparte
   * de "Verificar estado". `sent`: se mandó y la DIAN lo recibió, pero el
   * procesamiento asíncrono no terminó dentro del tiempo de espera de esta
   * función -- la fila queda igual que antes (`check_invoice_status` sigue
   * disponible como respaldo manual para este caso, ya no como paso
   * obligatorio). `error`: falló el ENVÍO en sí (fault SOAP, red, etc.),
   * nunca llegó a manos de la DIAN para validar nada. */
  status: "accepted" | "rejected" | "sent" | "error";
  httpStatus: number;
  cufe: string | null;
  dianTrackingId: string | null;
  /** Fallo de ENVÍO (SOAP fault / rechazo del sobre) -- no confundir con
   * `rejectionDetail`, que es un rechazo de VALIDACIÓN real de la DIAN
   * sobre el contenido del documento. */
  faultReason: string | null;
  /** Motivo real de rechazo (reglas FAxx) cuando `status === "rejected"`. */
  rejectionDetail: string | null;
  invoicePrefix: string;
  invoiceNumber: number;
  /** Solo se llena en modo diagnóstico (`dryRun`) -- el XML firmado tal cual
   * se mandaría, para poder inspeccionarlo/compararlo sin gastar un intento
   * real del test set de habilitación. */
  signedXml?: string;
}

export interface SendInvoiceOptions {
  /** Arma y firma el XML pero NO lo manda a la DIAN ni escribe nada en la
   * base -- devuelve el documento en `signedXml` para diagnóstico. Agregado
   * 2026-09-10 contra el rechazo ZE02 persistente: hacía falta ver los bytes
   * exactos que se transmiten para compararlos contra una factura real ya
   * aceptada, sin quemar otro consecutivo. */
  dryRun?: boolean;
}

/** Envía la factura `invoiceId` (fila de sales_invoices, status debe ser
 * 'pending') del tenant `tenantId`. Actualiza la fila con el resultado
 * (status/cufe/dian_tracking_id/dian_response/sent_at) antes de retornar,
 * tanto en éxito como en fault -- así "Facturas" siempre refleja el último
 * intento real, no queda desactualizada si el caller no vuelve a leer. */
// deno-lint-ignore no-explicit-any
export async function sendInvoiceToDian(adminClient: any, tenantId: string, invoiceId: string, options: SendInvoiceOptions = {}): Promise<SendInvoiceResult> {
  const dryRun = options.dryRun === true;
  const { data: invoicePre, error: invoicePreError } = await adminClient
    .from("sales_invoices")
    .select("id, status, order_id")
    .eq("id", invoiceId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (invoicePreError || !invoicePre) throw new Error("Factura no encontrada.");
  // En dry run se permite cualquier estado -- justamente sirve para inspeccionar
  // el XML de una factura YA rechazada, sin crear un intento nuevo.
  if (!dryRun && invoicePre.status !== "pending") {
    throw new Error(`Esta factura está en estado "${invoicePre.status}", no "pending" -- para reintentar hay que crear un intento nuevo (ver retry_invoice en dian-submit).`);
  }

  // El snapshot se rearma con el pedido tal como está AHORA, justo antes de
  // construir el XML. El pedido sigue siendo editable después de confirmarse
  // (se bloquea recién cuando la DIAN lo acepta/recibe, ver dianLocksOrder en
  // OrderDetail.tsx), así que el snapshot congelado al confirmar podía estar
  // viejo: corregir un precio entre "confirmar" y "enviar" transmitía los
  // valores anteriores. Después de esto el pedido queda bloqueado, así que lo
  // enviado y lo que se ve en pantalla ya no pueden divergir.
  if (!dryRun) await refreshInvoiceSnapshot(adminClient, tenantId, invoiceId, invoicePre.order_id);

  const { data: invoice, error: invoiceError } = await adminClient
    .from("sales_invoices")
    .select("id, status, buyer_snapshot, seller_snapshot, subtotal, tax_total, total, currency")
    .eq("id", invoiceId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (invoiceError || !invoice) throw new Error("Factura no encontrada.");

  const { data: items, error: itemsError } = await adminClient
    .from("sales_invoice_items")
    .select("description:product_name, sku, quantity, unit_price, subtotal, tax_type_code, tax_rate, tax_amount, taxable_base, display_order")
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
  if (!profile.webservice_url) throw new Error("Falta la URL del web service en la configuración DIAN de este tenant.");
  if (!profile.software_id) throw new Error("Falta el Software ID en la configuración DIAN de este tenant.");
  if (!profile.resolution_prefix || !profile.resolution_range_from) {
    throw new Error("Falta la resolución de facturación (prefijo/rango) en la configuración DIAN de este tenant.");
  }

  const credential = await resolveTenantIntegrationCredential(adminClient, tenantId, PROVIDER_KEY);
  // El ambiente sale del selector "Modo" que ya tiene toda tarjeta de
  // Integraciones (`integration_credentials.mode`), rotulado para la DIAN
  // como "Habilitación (pruebas)" / "Producción" -- no hace falta un campo
  // aparte. El Test Set ID solo aplica en habilitación: en producción la
  // operación es SendBillSync, que no lo recibe.
  const isProduction = credential.mode === "production";
  if (!isProduction && !profile.test_set_id) throw new Error("Falta el Test Set ID en la configuración DIAN de este tenant.");
  const getSecret = makeIntegrationSecretGetter(adminClient, credential.id);
  const softwarePin = await getSecret("software_pin");
  // La clave técnica cargada a mano ya NO es la fuente de verdad en
  // producción -- solo el respaldo si la consulta de rangos a la DIAN
  // falla. Ver resolveTechnicalKey.ts (Anexo Técnico v1.9, numeral 11.6:
  // la clave pertenece al RANGO, no al tenant ni al software).
  const storedTechnicalKey = await getSecret("technical_key");
  if (!softwarePin) throw new Error("Falta el PIN del software en Integraciones.");

  const cert = await loadTenantCertificate(adminClient, tenantId);

  const buyer = invoice.buyer_snapshot as BuyerSnapshot;
  const seller = invoice.seller_snapshot as SellerSnapshot;
  if (!buyer.document_type_code || !buyer.document_number) throw new Error("El comprador no tiene documento fiscal completo.");
  if (!seller.legal_name || !seller.document_number) throw new Error("El vendedor (tenant) no tiene razón social/NIT completos.");
  // NO se bloquea el envío por falta de dirección/código DANE -- una venta
  // de mostrador real a un cliente identificado (cédula) pero sin domicilio
  // guardado es un caso legítimo y frecuente (probado en vivo 2026-09-10
  // contra un pedido real del POS), no un dato faltante por error. Sin
  // dirección, buildInvoiceXml.ts omite el grupo entero (a lo sumo genera
  // una notificación blanda, FAK08/FAK28); con dirección pero sin código
  // DANE, lo manda igual sin el código. Bloquear acá dejaría sin poder
  // facturarse a cualquier venta de mostrador sin domicilio -- peor que la
  // notificación blanda que se evita.

  const invoiceNumber = profile.next_invoice_number ?? profile.resolution_range_from;
  const invoicePrefix = profile.resolution_prefix;
  const invoiceDocId = `${invoicePrefix}${invoiceNumber}`;
  const now = new Date();
  // Hora REAL de Colombia -- ver colombiaTime.ts (antes se emitía la hora
  // UTC etiquetada como -05:00, cinco horas adelantada).
  const { issueDate, issueTime } = colombiaIssueMoment(now);

  const resolvedKey = await resolveTechnicalKey({
    adminClient,
    tenantId,
    isProduction,
    prefix: invoicePrefix,
    documentNumber: Number(invoiceNumber),
    storedKey: storedTechnicalKey,
  });
  // Se guarda junto a la respuesta cruda para que un rechazo futuro por
  // CUFE (FAD06) sea diagnosticable de una: dice si la clave salió del
  // rango real que reportó la DIAN o si se cayó al valor manual, y por qué.
  const technicalKeyDiagnostics = { source: resolvedKey.source, fallbackReason: resolvedKey.fallbackReason };

  // cac:PaymentMeans (reglas FAN01/FAN02/FAN03 -- ver buildInvoiceXml.ts)
  // se arma con el pago REAL más reciente de este pedido, nunca inventado:
  // "1" contado / "2" crédito, y el código de medio de pago según el
  // método real (catálogo UNCL4461 que usa la DIAN).
  const { data: latestPayment } = await adminClient
    .from("sales_order_payments")
    .select("method")
    .eq("order_id", invoicePre.order_id)
    .is("deleted_at", null)
    .order("paid_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const paymentMethod = latestPayment?.method ?? null;
  const PAYMENT_MEANS_CODE: Record<string, string> = {
    efectivo: "10",
    transferencia: "42",
    wompi: "42",
    tarjeta: "48",
  };
  const xmlPayment = {
    meansId: (paymentMethod === "credito" ? "2" : "1") as "1" | "2",
    meansCode: (paymentMethod && PAYMENT_MEANS_CODE[paymentMethod]) || "1",
  };

  const lines: InvoiceXmlLine[] = items.map((item: Record<string, unknown>, idx: number) => ({
    id: idx + 1,
    description: String(item.description ?? "Producto"),
    sku: item.sku ? String(item.sku) : null,
    quantity: Number(item.quantity),
    unitPrice: Number(item.unit_price),
    lineExtensionAmount: Number(item.subtotal),
    tax: item.tax_type_code
      ? { code: String(item.tax_type_code), rate: Number(item.tax_rate), taxableAmount: Number(item.taxable_base), taxAmount: Number(item.tax_amount) }
      : null,
  }));

  const xmlInput: BuildInvoiceXmlInput = {
    invoiceId: invoiceDocId,
    issueDate,
    issueTime,
    currency: invoice.currency ?? "COP",
    environment: isProduction ? 1 : 2,
    seller: {
      legalName: seller.legal_name,
      documentTypeCode: "31", // los tenants (empresas) que facturan son NIT prácticamente siempre -- ver nota en sendToDian.ts
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
    },
    lines,
    withholdings: [], // el cálculo real de retenciones (tenant_withholding_configs + applies_withholding) es trabajo futuro, ver plan
    resolution: {
      number: profile.resolution_number ?? "",
      prefix: profile.resolution_prefix,
      rangeFrom: String(profile.resolution_range_from),
      rangeTo: String(profile.resolution_range_to ?? profile.resolution_range_from),
      validFrom: profile.resolution_valid_from ?? issueDate,
      validUntil: profile.resolution_valid_until ?? issueDate,
    },
    softwareId: profile.software_id,
    softwarePin,
    technicalKey: resolvedKey.technicalKey,
    authorizationProviderNit: "800197268",
    payment: xmlPayment,
  };

  const { xml: unsignedXml, cufe } = await buildInvoiceXml(xmlInput);
  const signedInvoiceXml = await signInvoiceXml({ unsignedXml, privateKey: cert.privateKey, certificateDer: cert.certificateDer });

  if (dryRun) {
    return {
      status: "sent",
      httpStatus: 0,
      cufe,
      dianTrackingId: null,
      faultReason: null,
      rejectionDetail: null,
      invoicePrefix,
      invoiceNumber: Number(invoiceNumber),
      signedXml: signedInvoiceXml,
    };
  }

  // Conservación del documento electrónico de generación, ANTES de
  // transmitir -- ver storeSignedXml.ts para el porqué del momento y de
  // que no bloquee.
  await storeSignedXml(adminClient, {
    tenantId,
    table: "sales_invoices",
    rowId: invoiceId,
    documentName: invoiceDocId,
    xml: signedInvoiceXml,
  });

  const zipFileName = `${invoiceDocId}.zip`;
  const zipBytes = buildInvoiceZip([{ fileName: `${invoiceDocId}.xml`, content: new TextEncoder().encode(signedInvoiceXml) }]);
  const zipBase64 = uint8ToBase64(zipBytes);

  // Producción usa `SendBillSync` (factura individual, sin testSetId);
  // habilitación sigue usando `SendTestSetAsync` contra el set de pruebas.
  // Una vez que la DIAN acepta el set de pruebas lo cierra, y cualquier
  // envío posterior por ese camino falla con "Set de prueba ... se
  // encuentra Aceptado" -- de ahí que el ambiente tenga que ser configurable
  // por tenant (ver la migración 20260910160000).
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

  // `SendBillSync` (producción) es SÍNCRONA: el veredicto real ya viene en
  // esta misma respuesta, como un único `DianResponse` sin envolver en
  // array y sin `ZipKey` -- se parsea con `parseOneStatus`, el mismo parser
  // que usa `GetStatusZip` (mismos nombres de campo, confirmado contra el
  // WSDL público). No hay polling posterior porque no hay nada async que
  // consultar.
  if (isProduction) {
    const faultMatch = responseBody.match(/<s:Text[^>]*>([^<]+)<\/s:Text>/) ?? responseBody.match(/<faultstring[^>]*>([^<]+)<\/faultstring>/i);
    const parsed = faultMatch ? null : parseOneStatus(responseBody);
    if (!parsed || parsed.isValid === null) {
      // Nunca se armó un veredicto real (SOAP fault, error de transporte,
      // etc.) -- mismo criterio que un fallo de envío: el consecutivo NO se
      // toca, el mismo número queda libre para el próximo intento.
      const faultReason = faultMatch?.[1] ?? "La DIAN no devolvió un veredicto reconocible.";
      await adminClient
        .from("sales_invoices")
        .update({ status: "error", status_detail: faultReason, cufe, dian_response: { httpStatus, responseBody, technicalKey: technicalKeyDiagnostics }, sent_at: nowIso })
        .eq("id", invoiceId);
      return { status: "error", httpStatus, cufe, dianTrackingId: null, faultReason, rejectionDetail: null, invoicePrefix, invoiceNumber: Number(invoiceNumber) };
    }

    // Mismo criterio de "guardar antes de interpretar" que el camino
    // asíncrono (ver más abajo) -- si el UPDATE choca contra el índice
    // único de invoice_number, hay que enterarse antes de aplicar el
    // veredicto sobre una fila que nunca quedó registrada como enviada.
    const { error: markSentError } = await adminClient
      .from("sales_invoices")
      .update({
        status: "sent",
        status_detail: null,
        invoice_prefix: invoicePrefix,
        invoice_number: invoiceNumber,
        issue_date: nowIso,
        cufe,
        dian_tracking_id: parsed.xmlDocumentKey,
        dian_response: { httpStatus, responseBody, technicalKey: technicalKeyDiagnostics },
        sent_at: nowIso,
      })
      .eq("id", invoiceId);
    if (markSentError) {
      throw new Error(`La DIAN validó la factura pero no se pudo guardar el resultado: ${markSentError.message}`);
    }
    await adminClient.from("sales_orders").update({ has_invoice: true }).eq("id", invoicePre.order_id);

    const verdict = interpretDianStatus(parsed);
    await applyInvoiceVerdict(adminClient, tenantId, invoiceId, Number(invoiceNumber), verdict);

    return {
      status: verdict.outcome === "accepted" ? "accepted" : verdict.outcome === "rejected" ? "rejected" : "sent",
      httpStatus,
      cufe,
      dianTrackingId: parsed.xmlDocumentKey,
      faultReason: null,
      rejectionDetail: verdict.outcome === "rejected" ? verdict.detail : null,
      invoicePrefix,
      invoiceNumber: Number(invoiceNumber),
    };
  }

  // A partir de acá: habilitación (`SendTestSetAsync`), asíncrona -- sin
  // cambios respecto a antes.
  const zipKeyMatch = responseBody.match(/<b:zipkey>([^<]+)<\/b:zipkey>/i);
  const faultMatch = responseBody.match(/<s:Text[^>]*>([^<]+)<\/s:Text>/);
  // Un HTTP 200 no significa "aceptada" -- SendTestSetAsync puede responder
  // 200 con éxito=false y el motivo real en ProcessedMessage (ej. "MIMEType
  // del archivo inválido"), sin ningún s:Fault. Sin este match el error
  // quedaba invisible y el usuario solo veía el mensaje genérico de "no se
  // pudo enviar" -- encontrado en vivo el 2026-09-09 (bug real de zip.ts,
  // ya corregido, pero el mensaje real tampoco se estaba mostrando).
  const processedMessageMatch = responseBody.match(/<c:ProcessedMessage>([^<]+)<\/c:ProcessedMessage>/i);
  const zipKey = zipKeyMatch ? zipKeyMatch[1] : null;
  const faultReason = zipKey ? null : (faultMatch?.[1] ?? processedMessageMatch?.[1] ?? null);

  if (!zipKey) {
    // Falló el ENVÍO en sí -- nunca llegó a manos de la DIAN para validar
    // nada, así que el consecutivo (next_invoice_number) NO se toca: el
    // mismo número queda libre para el próximo intento real (pedido
    // explícito del usuario 2026-09-09).
    await adminClient
      .from("sales_invoices")
      .update({
        status: "error",
        status_detail: faultReason ?? `HTTP ${httpStatus}`,
        cufe,
        dian_response: { httpStatus, responseBody, technicalKey: technicalKeyDiagnostics },
        sent_at: nowIso,
      })
      .eq("id", invoiceId);
    return { status: "error", httpStatus, cufe, dianTrackingId: null, faultReason, rejectionDetail: null, invoicePrefix, invoiceNumber: Number(invoiceNumber) };
  }

  // Acuse de recibo -- SendTestSetAsync es asíncrona, esto todavía no es
  // el veredicto real. Se guarda como 'sent' primero (para no perder el
  // tracking id si el polling de abajo revienta por lo que sea) y recién
  // después se corrige a 'accepted'/'rejected' si el polling resuelve.
  //
  // Bug real encontrado en vivo 2026-09-10: este UPDATE puede fallar (ej.
  // choque contra el índice único de invoice_number si dos intentos del
  // mismo pedido terminan compitiendo por el mismo consecutivo -- ver la
  // migración 20260910040000) y el código anterior nunca revisaba el
  // resultado -- la DIAN ya había recibido y procesado la factura de
  // verdad, pero cufe/dian_tracking_id/sent_at se perdían en silencio: el
  // polling de abajo seguía corriendo con el zipKey en memoria y
  // applyInvoiceVerdict SÍ lograba escribir "rejected" después (esos campos
  // no chocan), dejando una fila contradictoria (rechazada pero sin
  // registro de que en verdad se envió). Ahora se corta acá con un error
  // claro apenas el guardado falla, antes de gastar tiempo/CPU en el
  // polling con un estado que no se pudo persistir.
  const { error: markSentError } = await adminClient
    .from("sales_invoices")
    .update({
      status: "sent",
      status_detail: null,
      invoice_prefix: invoicePrefix,
      invoice_number: invoiceNumber,
      issue_date: nowIso,
      cufe,
      dian_tracking_id: zipKey,
      dian_response: { httpStatus, responseBody, technicalKey: technicalKeyDiagnostics },
      sent_at: nowIso,
    })
    .eq("id", invoiceId);
  if (markSentError) {
    throw new Error(`La DIAN recibió la factura (zipKey ${zipKey}) pero no se pudo guardar el resultado: ${markSentError.message}`);
  }
  // Flag denormalizado para filtrar/sumar "Órdenes" sin joinear contra
  // sales_invoices en cada carga -- ver get_sales_orders_summary. Solo se
  // pone en true, nunca se revierte (no existe un flujo de anular una
  // factura ya aceptada). Deliberadamente NO se mueve a "solo si
  // accepted" -- eso es la misma decisión de "dejarlo para otra fase" que
  // el usuario pidió para la descarga del PDF (isRemision usa este mismo
  // criterio), no forma parte de este ajuste.
  await adminClient.from("sales_orders").update({ has_invoice: true }).eq("id", invoicePre.order_id);

  // Pedido explícito del usuario 2026-09-09: este mismo endpoint se
  // encarga de verificar el estado real -- consulta GetStatusZip un par de
  // veces seguidas (con pausas cortas) antes de devolver el resultado, en
  // vez de dejar la factura en un "sent" ambiguo y obligar a un botón
  // aparte. Si la DIAN no alcanza a resolver dentro de este tiempo de
  // espera, la fila queda en 'sent' -- "Verificar estado" sigue existiendo
  // como respaldo manual para ese caso puntual, ya no como paso obligatorio.
  const polled = await pollDianTrackStatus(adminClient, tenantId, zipKey);
  const verdict = interpretDianStatus(polled.statuses[0] ?? null);
  await applyInvoiceVerdict(adminClient, tenantId, invoiceId, Number(invoiceNumber), verdict);

  return {
    status: verdict.outcome === "accepted" ? "accepted" : verdict.outcome === "rejected" ? "rejected" : "sent",
    httpStatus,
    cufe,
    dianTrackingId: zipKey,
    faultReason: null,
    rejectionDetail: verdict.outcome === "rejected" ? verdict.detail : null,
    invoicePrefix,
    invoiceNumber: Number(invoiceNumber),
  };
}
