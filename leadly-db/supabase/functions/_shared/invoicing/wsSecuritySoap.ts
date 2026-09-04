/** Firma WS-Security del sobre SOAP hacia la DIAN -- distinta de la firma
 * XAdES-EPES que ya va dentro del XML de la factura (signInvoiceXml.ts).
 * Esta es la firma que exige el transporte mismo: el Anexo Técnico (§7.5,
 * confirmado) dice que el modelo de comunicación sigue "WS-Security 1.0
 * Oasis, con autenticación X.509 Certificate Token Profile 1.1" -- y el
 * Suplemento F (guía SoapUI oficial, Ilustración 5, página 712 del PDF)
 * muestra la configuración exacta usada para firmar: Key Identifier Type
 * "Binary Security Token", Signature Algorithm RSA-SHA256, Canonicalization
 * exc-c14n, Digest Algorithm SHA256, firmando el elemento `wsa:To` de
 * WS-Addressing.
 *
 * ⚠️ A diferencia de cufe.ts/signInvoiceXml.ts, ESTA PIEZA NO ESTÁ
 * VERIFICADA contra un ejemplo oficial completo -- no existe un ejemplo
 * público de un sobre SOAP ya firmado con WS-Security para comparar
 * byte-a-byte (a diferencia del CUFE o la política de firma XAdES, que sí
 * tenían un valor de referencia oficial). Lo que sigue es la mejor
 * implementación posible a partir de la documentación oficial + el
 * screenshot de configuración, pero falta probarla contra el ambiente real
 * de habilitación de la DIAN antes de confiar en que un WS real la acepte.
 *
 * También falta confirmar la URL del web service y las credenciales de
 * Basic Auth que pide además de esta firma (ver Anexo Técnico Ilustración 7 --
 * no explica de dónde salen, solo que hay que agregarlas). */
import { DOMParser, XMLSerializer } from "npm:@xmldom/xmldom@0.8";
import * as xmldsig from "npm:xmldsigjs@2";

let engineReady = false;
function ensureEngine(): void {
  if (engineReady) return;
  // deno-lint-ignore no-explicit-any
  (globalThis as any).DOMParser = DOMParser;
  // deno-lint-ignore no-explicit-any
  (globalThis as any).XMLSerializer = XMLSerializer;
  xmldsig.Application.setEngine("Deno", crypto);
  engineReady = true;
}

function bufToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

const WSSE_NS = "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd";
const WSU_NS = "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd";
const WSA_NS = "http://www.w3.org/2005/08/addressing";
const DS_NS = "http://www.w3.org/2000/09/xmldsig#";

export interface BuildSoapEnvelopeInput {
  /** URL del método, ej. "http://wcf.dian.colombia/IWcfDianCustomerServices/SendTestSetAsync" */
  action: string;
  /** URL del web service (destino WS-Addressing wsa:To). */
  to: string;
  /** Cuerpo del soap:Body ya armado, sin el elemento raíz soap:Envelope -- ej. el <wcf:SendTestSetAsync>...</wcf:SendTestSetAsync>. */
  bodyXml: string;
  privateKey: CryptoKey;
  certificateDer: ArrayBuffer;
}

/** Arma el sobre SOAP 1.2 completo (Header con WS-Addressing + WS-Security
 * firmado, Body con el método real) tal como lo exige la DIAN. El resultado
 * es el XML del sobre -- todavía sin envolver en el multipart MTOM que pide
 * el transporte cuando hay un adjunto binario (ver mtomEnvelope.ts). */
export async function buildSignedSoapEnvelope(input: BuildSoapEnvelopeInput): Promise<string> {
  ensureEngine();

  const timestampId = "Timestamp-" + crypto.randomUUID();
  const toId = "To-" + crypto.randomUUID();
  const bstId = "X509Token-" + crypto.randomUUID();
  const created = new Date();
  const expires = new Date(created.getTime() + 5 * 60 * 1000);

  const certB64 = bufToBase64(input.certificateDer);

  // wsa:To lleva Id duplicado (wsu:Id -- lo que exige el estándar WS-Security
  // -- e Id sin prefijo): xmldsigjs resuelve ds:Reference URI="#..." con
  // element.hasAttribute("Id") literal, no reconoce wsu:Id como xsd:ID. Sin
  // el duplicado sin prefijo, la firma local nunca encuentra el nodo.
  const envelopeXml = `<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:wsa="${WSA_NS}" xmlns:wsse="${WSSE_NS}" xmlns:wsu="${WSU_NS}">
  <soap:Header>
    <wsa:Action>${escapeXml(input.action)}</wsa:Action>
    <wsa:To wsu:Id="${toId}" Id="${toId}">${escapeXml(input.to)}</wsa:To>
    <wsse:Security soap:mustUnderstand="1">
      <wsu:Timestamp wsu:Id="${timestampId}">
        <wsu:Created>${created.toISOString()}</wsu:Created>
        <wsu:Expires>${expires.toISOString()}</wsu:Expires>
      </wsu:Timestamp>
      <wsse:BinarySecurityToken wsu:Id="${bstId}" ValueType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-x509-token-profile-1.0#X509v3" EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${certB64}</wsse:BinarySecurityToken>
    </wsse:Security>
  </soap:Header>
  <soap:Body>
    ${input.bodyXml}
  </soap:Body>
</soap:Envelope>`;

  const doc = new DOMParser().parseFromString(envelopeXml, "text/xml");
  const securityNode = doc.getElementsByTagNameNS(WSSE_NS, "Security")[0];
  if (!securityNode) throw new Error("No se pudo armar el nodo wsse:Security del sobre SOAP.");

  // deno-lint-ignore no-explicit-any
  const signedXml = new (xmldsig as any).SignedXml(securityNode);
  await signedXml.Sign(
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    input.privateKey,
    doc,
    {
      references: [{ uri: `#${toId}`, hash: "SHA-256", transforms: ["exc-c14n"] }],
    },
  );

  const signatureNode = signedXml.GetXml();
  if (!signatureNode) throw new Error("La firma WS-Security no generó ningún nodo ds:Signature.");

  // KeyInfo por defecto de xmldsigjs queda vacío (no le pasamos `x509` --
  // el patrón "Binary Security Token" del screenshot referencia el BST ya
  // insertado en el header, no repite el certificado inline). Se reemplaza
  // el ds:KeyInfo vacío que xmldsigjs igual agrega por un
  // wsse:SecurityTokenReference apuntando al BST, patrón estándar de
  // WS-Security X.509 Token Profile.
  const keyInfoNodes = signatureNode.getElementsByTagNameNS(DS_NS, "KeyInfo");
  const strXml = `<wsse:SecurityTokenReference xmlns:wsse="${WSSE_NS}"><wsse:Reference URI="#${bstId}" ValueType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-x509-token-profile-1.0#X509v3"/></wsse:SecurityTokenReference>`;
  const strDoc = new DOMParser().parseFromString(strXml, "text/xml");
  const strNode = doc.importNode ? doc.importNode(strDoc.documentElement, true) : strDoc.documentElement;
  if (keyInfoNodes.length > 0) {
    const keyInfo = keyInfoNodes[0];
    while (keyInfo.firstChild) keyInfo.removeChild(keyInfo.firstChild);
    keyInfo.appendChild(strNode);
  } else {
    const keyInfoXml = `<ds:KeyInfo xmlns:ds="${DS_NS}"></ds:KeyInfo>`;
    const keyInfoDoc = new DOMParser().parseFromString(keyInfoXml, "text/xml");
    const keyInfoNode = doc.importNode ? doc.importNode(keyInfoDoc.documentElement, true) : keyInfoDoc.documentElement;
    keyInfoNode.appendChild(strNode);
    signatureNode.appendChild(keyInfoNode);
  }

  securityNode.appendChild(doc.importNode ? doc.importNode(signatureNode, true) : signatureNode);

  return new XMLSerializer().serializeToString(doc);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
