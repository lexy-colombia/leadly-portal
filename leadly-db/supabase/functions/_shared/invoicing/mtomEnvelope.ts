/** Empaqueta el sobre SOAP + el ZIP adjunto en un mensaje MTOM
 * (multipart/related, XOP) -- el formato de transporte real que usa el
 * ejemplo oficial de la DIAN para SendBillAsync/SendTestSetAsync.
 *
 * Evidencia de que es MTOM y no base64 inline (Anexo Técnico, Suplemento F):
 * - El XML de ejemplo de la petición muestra `<wcf:contentFile>cid:179956799470</wcf:contentFile>`
 *   -- un `cid:` es exactamente cómo XOP referencia un adjunto MIME, no un
 *   valor real.
 * - Las capturas de SoapUI (Ilustración 10, página 720 del PDF) muestran un
 *   tab "Attachments" con el .zip cargado, "Part." (el Content-ID) y
 *   "Cached" -- la UI estándar de SoapUI para adjuntos MTOM, no para
 *   contenido embebido en el XML.
 *
 * ⚠️ Sin verificar contra un envío real -- no hay forma de confirmar esto
 * sin las credenciales/URL reales de la DIAN (ver wsSecuritySoap.ts). La
 * estructura sigue el estándar MTOM/XOP (RFC 7285 / W3C XOP) al pie de la
 * letra, que es lo máximo que se puede verificar offline. */

export interface MtomMessage {
  /** Cuerpo completo listo para mandar como HTTP body. */
  body: Uint8Array;
  /** Header Content-Type completo a mandar con la petición HTTP. */
  contentType: string;
}

export interface BuildMtomInput {
  /** XML del sobre SOAP ya firmado, con <wcf:contentFile> reemplazado por
   * un <xop:Include href="cid:..."/> (ver buildXopEnvelope). */
  soapXml: string;
  /** Bytes crudos del adjunto (el .zip). */
  attachment: Uint8Array;
  attachmentContentId: string;
  attachmentContentType?: string;
}

/** Reemplaza el placeholder de texto `cid:<id>` dentro de un elemento del
 * XML por el elemento XOP real `<xop:Include href="cid:<id>"/>` que exige
 * el estándar -- el ejemplo del Anexo Técnico muestra el texto plano
 * `cid:...` como valor del elemento porque así lo renderiza SoapUI en su
 * vista "Raw" simplificada, pero el XOP real va como elemento hijo, no
 * como texto. */
export function buildXopEnvelope(soapXmlWithPlainCid: string, cidPlaceholder: string, contentId: string): string {
  const xopInclude = `<xop:Include xmlns:xop="http://www.w3.org/2004/08/xop/include" href="cid:${contentId}"/>`;
  return soapXmlWithPlainCid.replace(`cid:${cidPlaceholder}`, xopInclude);
}

export function buildMtomMessage(input: BuildMtomInput): MtomMessage {
  const boundary = "MIME_boundary_" + crypto.randomUUID().replace(/-/g, "");
  const rootContentId = "root.message@leadly";
  const CRLF = "\r\n";

  const soapPartHeaders =
    `--${boundary}${CRLF}` +
    `Content-Type: application/xop+xml; charset=UTF-8; type="application/soap+xml"${CRLF}` +
    `Content-Transfer-Encoding: 8bit${CRLF}` +
    `Content-ID: <${rootContentId}>${CRLF}${CRLF}`;

  const soapPartBody = input.soapXml + CRLF;

  const attachmentHeaders =
    `--${boundary}${CRLF}` +
    `Content-Type: ${input.attachmentContentType ?? "application/zip"}${CRLF}` +
    `Content-Transfer-Encoding: binary${CRLF}` +
    `Content-ID: <${input.attachmentContentId}>${CRLF}${CRLF}`;

  const closing = `${CRLF}--${boundary}--`;

  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [
    encoder.encode(soapPartHeaders),
    encoder.encode(soapPartBody),
    encoder.encode(attachmentHeaders),
    input.attachment,
    encoder.encode(closing),
  ];

  const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
  const body = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.length;
  }

  const contentType =
    `multipart/related; type="application/xop+xml"; start="<${rootContentId}>"; ` +
    `start-info="application/soap+xml"; boundary="${boundary}"`;

  return { body, contentType };
}
