/** Consulta a la DIAN el estado REAL de un documento ya enviado --
 * `SendTestSetAsync` (y `SendBillAsync`) son asíncronas: el `zipKey` que
 * devuelven al mandarlas (guardado en `dian_tracking_id`) es solo un acuse
 * de recibo ("lo recibí, lo voy a procesar"), NO la validación final. Hasta
 * esta pieza, sendInvoiceToDian.ts/sendCreditNoteToDian.ts marcaban la fila
 * como 'sent' apenas llegaba ese acuse y nunca volvían a preguntar qué pasó
 * después -- bug real reportado en vivo 2026-09-09: el usuario no veía sus
 * facturas de prueba por ningún lado en la sección de Habilitación del
 * portal de la DIAN, y no había forma de saber si de verdad se habían
 * procesado, quedado rechazadas, o seguían en cola.
 *
 * Operación real: `GetStatusZip(trackId)` -- se usa esta y no `GetStatus`
 * porque lo que mandamos siempre es un ZIP (ver zip.ts), aunque adentro
 * tenga un solo documento; `GetStatusZip` devuelve un array de
 * `DianResponse` (uno por documento dentro del zip -- en nuestro caso,
 * siempre length 1). Contrato confirmado contra el WSDL público
 * (https://vpfe-hab.dian.gov.co/WcfDianCustomerServices.svc?singleWsdl,
 * 2026-09-09), mismo criterio que getNumberingRange.ts: request
 * `<wcf:GetStatusZip><wcf:trackId>...</wcf:trackId></wcf:GetStatusZip>`,
 * response `GetStatusZipResponse > GetStatusZipResult` (ArrayOfDianResponse),
 * cada `DianResponse` con `IsValid`/`StatusCode`/`StatusDescription`/
 * `StatusMessage`/`ErrorMessage[]`/`XmlDocumentKey`/`XmlFileName` (más
 * `XmlBase64Bytes`/`XmlBytes`, que no se leen acá -- no hace falta el XML
 * de vuelta, solo el veredicto).
 *
 * Parseo namespace-agnóstico, mismo motivo documentado en
 * getNumberingRange.ts/wsSecuritySoap.ts -- y, a diferencia de esa pieza
 * (que hubo que corregir dos veces en vivo: nombre de operación mal y
 * parámetro faltante), acá el contrato ya viene confirmado del WSDL, pero
 * la forma exacta de cómo el serializador de .NET envuelve cada item del
 * array (`<DianResponse>` repetido vs. otro nombre) todavía no se probó en
 * vivo -- por eso hay un fallback que trata la respuesta completa como un
 * solo bloque si no encuentra bloques repetidos. */
import { buildSignedSoapEnvelope } from "./wsSecuritySoap.ts";
import { loadTenantCertificate, createMtlsClient, type TenantCertificate } from "./dianClient.ts";
import { interpretDianStatus } from "./applyDianVerdict.ts";

const ACTION = "http://wcf.dian.colombia/IWcfDianCustomerServices/GetStatusZip";

export interface DianTrackStatus {
  isValid: boolean | null;
  statusCode: string | null;
  statusDescription: string | null;
  statusMessage: string | null;
  errorMessages: string[];
  xmlDocumentKey: string | null;
  xmlFileName: string | null;
}

export interface GetDianStatusResult {
  httpStatus: number;
  responseBody: string;
  faultReason: string | null;
  statuses: DianTrackStatus[];
}

/** Consulta el estado real de `trackId` (el `dian_tracking_id`/zipKey ya
 * guardado en sales_invoices/sales_credit_notes) contra la DIAN. Lanza si
 * falta configuración básica (perfil, certificado) -- un fault SOAP de la
 * DIAN misma NO lanza, vuelve como `faultReason` (mismo criterio que el
 * resto de esta integración). */
// deno-lint-ignore no-explicit-any
export async function queryDianTrackStatus(adminClient: any, tenantId: string, trackId: string, preloadedCert?: TenantCertificate): Promise<GetDianStatusResult> {
  const { data: profile, error: profileError } = await adminClient
    .from("tenant_dian_profile")
    .select("webservice_url")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (profileError || !profile) throw new Error("Este tenant no tiene perfil DIAN configurado.");
  if (!profile.webservice_url) {
    throw new Error("Falta la URL del web service en la configuración DIAN de este tenant (Integraciones).");
  }

  // Reusa el certificado ya cargado cuando el caller lo pasa (ver
  // pollDianTrackStatus) -- parsePkcs12 descifra el .p12 con el KDF legado
  // de PKCS12 en JS puro (node-forge, ver certificate.ts), una operación
  // realmente pesada de CPU. Bug real encontrado en vivo 2026-09-10: al
  // corregir el polling para que seguisiera reintentando ante "todavía en
  // proceso" (ver applyDianVerdict.ts) en vez de cortar en el primer
  // intento, cada uno de esos reintentos volvía a descifrar el certificado
  // desde cero -- 8 descifrados PKCS12 + 8 firmas del sobre SOAP en una
  // sola invocación agotaban el límite de CPU de la Edge Function
  // (`"CPU Time exceeded"`, HTTP 546), tirando abajo el envío entero.
  const cert = preloadedCert ?? (await loadTenantCertificate(adminClient, tenantId));

  const bodyXml = `<wcf:GetStatusZip xmlns:wcf="http://wcf.dian.colombia"><wcf:trackId>${escapeXml(trackId)}</wcf:trackId></wcf:GetStatusZip>`;
  const envelope = await buildSignedSoapEnvelope({
    action: ACTION,
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
        SOAPAction: `"${ACTION}"`,
      },
      body: envelope,
    });
    httpStatus = resp.status;
    responseBody = await resp.text();
  } finally {
    client.close?.();
  }

  const faultMatch = responseBody.match(/<s:Text[^>]*>([^<]+)<\/s:Text>/) ?? responseBody.match(/<faultstring[^>]*>([^<]+)<\/faultstring>/i);
  const faultReason = faultMatch ? faultMatch[1] : null;
  const statuses = faultReason ? [] : parseStatuses(responseBody);

  return { httpStatus, responseBody, faultReason, statuses };
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function extractAll(xml: string, localName: string): string[] {
  const re = new RegExp(`<(?:[A-Za-z0-9]+:)?${localName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[A-Za-z0-9]+:)?${localName}>`, "g");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

/** Cada `DianResponse` trae adentro los campos escalares -- se extraen dentro
 * del bloque aislado (no del XML completo) para no mezclar campos de un
 * item con otro cuando `statuses.length > 1`. */
function parseOneStatus(block: string): DianTrackStatus {
  const isValidRaw = extractAll(block, "IsValid")[0] ?? null;
  const errorMessages = extractAll(block, "ErrorMessage")
    .flatMap((chunk) => {
      const nested = extractAll(chunk, "string");
      return nested.length > 0 ? nested : [chunk];
    })
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    isValid: isValidRaw === null ? null : isValidRaw.trim().toLowerCase() === "true",
    statusCode: extractAll(block, "StatusCode")[0]?.trim() ?? null,
    statusDescription: extractAll(block, "StatusDescription")[0]?.trim() ?? null,
    statusMessage: extractAll(block, "StatusMessage")[0]?.trim() ?? null,
    errorMessages,
    xmlDocumentKey: extractAll(block, "XmlDocumentKey")[0]?.trim() ?? null,
    xmlFileName: extractAll(block, "XmlFileName")[0]?.trim() ?? null,
  };
}

function parseStatuses(xml: string): DianTrackStatus[] {
  // .NET normalmente serializa un ArrayOf<T> repitiendo el elemento
  // "DianResponse" una vez por item -- ver comentario de cabecera.
  const blocks = extractAll(xml, "DianResponse");
  if (blocks.length > 0) return blocks.map(parseOneStatus);
  // Fallback: no se encontraron bloques repetidos (ej. GetStatus, que
  // devuelve un DianResponse único sin envolver en un array, o un
  // serializador que no usa ese nombre de elemento) -- se trata la
  // respuesta completa como un único resultado.
  return [parseOneStatus(xml)];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Pedido explícito del usuario 2026-09-09: el propio endpoint de envío
 * debe encargarse de verificar el veredicto real, no dejar al usuario en
 * un botón aparte de "Verificar estado" -- `SendTestSetAsync` solo confirma
 * "lo recibí", así que apenas se tiene el `trackId` (zipKey) hay que
 * preguntarle a la DIAN varias veces seguidas, con una pausa corta entre
 * cada intento, hasta que el procesamiento asíncrono real termine (o se
 * agote el tiempo razonable de espera dentro de una sola función Edge).
 *
 * Devuelve el último resultado obtenido -- si ninguno de los intentos fue
 * concluyente (`isValid` sigue null, o la DIAN respondió con un fault en
 * todos), el llamador debe tratarlo como "sigue en cola" (status
 * `sent`) y dejar la puerta abierta a reintentarlo más tarde a mano
 * (`check_invoice_status`/`check_credit_note_status`), no como un error. */
export async function pollDianTrackStatus(
  // deno-lint-ignore no-explicit-any
  adminClient: any,
  tenantId: string,
  trackId: string,
  { maxAttempts = 8, delayMs = 3000 }: { maxAttempts?: number; delayMs?: number } = {},
): Promise<GetDianStatusResult> {
  // Un solo descifrado del .p12 para todo el ciclo de reintentos -- ver el
  // comentario en queryDianTrackStatus sobre el costo real de CPU de
  // repetirlo por intento.
  const cert = await loadTenantCertificate(adminClient, tenantId);
  let last: GetDianStatusResult = { httpStatus: 0, responseBody: "", faultReason: null, statuses: [] };
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await sleep(delayMs);
    last = await queryDianTrackStatus(adminClient, tenantId, trackId, cert);
    // "Todavía en proceso de validación" (ver applyDianVerdict.ts) no es
    // concluyente -- antes se paraba acá mismo tratándolo como rechazo real,
    // que es exactamente el bug que motivó este chequeo compartido.
    const conclusive = !last.faultReason && interpretDianStatus(last.statuses[0] ?? null).outcome !== "inconclusive";
    if (conclusive) return last;
  }
  return last;
}
