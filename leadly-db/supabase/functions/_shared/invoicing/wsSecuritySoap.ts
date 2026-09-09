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
 * ⚠️ Dos rondas de bugs reales encontrados en producción, mismo síntoma
 * (`a:InvalidSecurity` / "An error occurred when verifying security for the
 * message.") las dos veces:
 * (1) Primera versión: solo xmldsigjs con `transforms: ["exc-c14n"]` sin
 * ningún `InclusiveNamespaces`, así que xmldsigjs propagaba al digest de
 * `wsa:To` los namespaces de sus ANCESTROS reales en el documento (wsa,
 * soap, wsse, wsu) -- pero el Anexo Técnico exige explícitamente
 * `InclusiveNamespaces PrefixList="soap wcf"` en el Transform del Reference
 * (y `"wsa soap wcf"` en el CanonicalizationMethod del propio SignedInfo).
 * (2) Segunda versión: se agregó ese `InclusiveNamespaces` a mano
 * canonicalizando un fragmento aislado con `soap`/`wcf` inyectados como
 * atributos -- pero `wcf` se inyectó como si fuera un ancestro real de
 * `wsa:To` sin serlo de verdad: en nuestro sobre `wcf` solo se declaraba
 * adentro de `<wcf:SendTestSetAsync>` (el Body), no en la raíz del
 * `soap:Envelope` -- así que el digest calculado no correspondía al
 * namespace realmente en alcance en ese punto del documento. Se encontró
 * releyendo el ejemplo de uso (no solo el código) de la implementación PHP
 * de referencia (github.com/Stenfrank/soap-dian): en SU ejemplo, `xmlns:wcf`
 * se declara en la raíz de `soap:Envelope` -- por eso su técnica de "inyectar
 * el namespace a mano" es válida ahí (reproduce un ancestro real), y por eso
 * ahora este archivo también declara `xmlns:wcf` en la raíz del sobre.
 *
 * Por eso esta versión NO usa `xmldsig.SignedXml` en absoluto -- construye
 * los dos fragmentos que hace falta canonicalizar (el `wsa:To` para el
 * digest, el `ds:SignedInfo` para la firma) como XML aislado con esos
 * namespaces puestos a mano, canonicaliza cada uno con
 * `XmlCanonicalizer(false, false)` (C14N normal, no exclusivo -- válido
 * porque el fragmento ya trae declarados explícitamente todos los
 * namespaces que hacen falta, así que "inclusivo" y "exclusivo con esa
 * misma lista" dan exactamente los mismos bytes) y firma/hashea directo con
 * Web Crypto. El resto del sobre (Timestamp, BinarySecurityToken, la
 * ubicación real de cada nodo) se ensambla como texto plano, replicando la
 * estructura de esa misma implementación de referencia.
 *
 * También falta confirmar la URL del web service y las credenciales de
 * Basic Auth que pide además de esta firma (ver Anexo Técnico Ilustración 7 --
 * no explica de dónde salen, solo que hay que agregarlas). */
import { DOMParser } from "npm:@xmldom/xmldom@0.8";
import * as xmldsig from "npm:xmldsigjs@2";

let engineReady = false;
function ensureEngine(): void {
  if (engineReady) return;
  // deno-lint-ignore no-explicit-any
  (globalThis as any).DOMParser = DOMParser;
  xmldsig.Application.setEngine("Deno", crypto);
  engineReady = true;
}

function bufToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/** C14N normal (no exclusivo) de un fragmento XML aislado -- el fragmento
 * ya trae declarados a mano todos los namespaces que hacen falta, así que
 * no hace falta (ni corresponde) resolver nada contra un documento más
 * grande. */
function canonicalizeStandalone(xml: string): string {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  // deno-lint-ignore no-explicit-any
  const canonicalizer = new (xmldsig as any).XmlCanonicalizer(false, false);
  return canonicalizer.Canonicalize(doc.documentElement);
}

const WSSE_NS = "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd";
const WSU_NS = "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd";
const WSA_NS = "http://www.w3.org/2005/08/addressing";
const DS_NS = "http://www.w3.org/2000/09/xmldsig#";
const SOAP_NS = "http://www.w3.org/2003/05/soap-envelope";
const WCF_NS = "http://wcf.dian.colombia";
const EXC_C14N = "http://www.w3.org/2001/10/xml-exc-c14n#";
const RSA_SHA256 = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";
const SHA256_URI = "http://www.w3.org/2001/04/xmlenc#sha256";
const X509_VALUE_TYPE = "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-x509-token-profile-1.0#X509v3";
const BASE64_ENCODING_TYPE = "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary";

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
 * firmado, Body con el método real) tal como lo exige la DIAN. */
export async function buildSignedSoapEnvelope(input: BuildSoapEnvelopeInput): Promise<string> {
  ensureEngine();

  const timestampId = "TS-" + crypto.randomUUID();
  const toId = "ID-" + crypto.randomUUID();
  const bstId = "SOENAC-" + crypto.randomUUID();
  const signatureId = "SIG-" + crypto.randomUUID();
  const keyInfoId = "KI-" + crypto.randomUUID();
  const strId = "STR-" + crypto.randomUUID();

  const created = new Date();
  const expires = new Date(created.getTime() + 5 * 60 * 1000);
  const certB64 = bufToBase64(input.certificateDer);
  const toValue = escapeXml(input.to);
  const actionValue = escapeXml(input.action);

  // Digest de wsa:To, canonicalizado en aislamiento con exactamente el
  // juego de namespaces que exige el Anexo Técnico (wsa propio + soap/wcf
  // inyectados a mano -- NO wsse, que sí sería "heredado" en el documento
  // real pero no debe entrar en este cálculo).
  const toFragmentXml = `<wsa:To xmlns:wsa="${WSA_NS}" xmlns:soap="${SOAP_NS}" xmlns:wcf="${WCF_NS}" wsu:Id="${toId}" xmlns:wsu="${WSU_NS}">${toValue}</wsa:To>`;
  const toCanon = canonicalizeStandalone(toFragmentXml);
  const toDigestBuf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(toCanon));
  const toDigestB64 = bufToBase64(toDigestBuf);

  const signedInfoInnerXml = `<ds:CanonicalizationMethod Algorithm="${EXC_C14N}"><ec:InclusiveNamespaces xmlns:ec="${EXC_C14N}" PrefixList="wsa soap wcf"/></ds:CanonicalizationMethod><ds:SignatureMethod Algorithm="${RSA_SHA256}"/><ds:Reference URI="#${toId}"><ds:Transforms><ds:Transform Algorithm="${EXC_C14N}"><ec:InclusiveNamespaces xmlns:ec="${EXC_C14N}" PrefixList="soap wcf"/></ds:Transform></ds:Transforms><ds:DigestMethod Algorithm="${SHA256_URI}"/><ds:DigestValue>${toDigestB64}</ds:DigestValue></ds:Reference>`;

  // Firma de SignedInfo: mismo truco -- se canonicaliza un fragmento
  // aislado con ds/wsa/soap/wcf inyectados a mano, nunca el SignedInfo tal
  // como quedaría heredando namespaces de sus ancestros reales.
  const signedInfoForSigningXml = `<ds:SignedInfo xmlns:ds="${DS_NS}" xmlns:wsa="${WSA_NS}" xmlns:soap="${SOAP_NS}" xmlns:wcf="${WCF_NS}">${signedInfoInnerXml}</ds:SignedInfo>`;
  const signedInfoCanon = canonicalizeStandalone(signedInfoForSigningXml);
  const signatureBuf = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, input.privateKey, new TextEncoder().encode(signedInfoCanon));
  const signatureB64 = bufToBase64(signatureBuf);

  const signatureXml = `<ds:Signature xmlns:ds="${DS_NS}" Id="${signatureId}"><ds:SignedInfo>${signedInfoInnerXml}</ds:SignedInfo><ds:SignatureValue>${signatureB64}</ds:SignatureValue><ds:KeyInfo Id="${keyInfoId}"><wsse:SecurityTokenReference wsu:Id="${strId}"><wsse:Reference URI="#${bstId}" ValueType="${X509_VALUE_TYPE}"/></wsse:SecurityTokenReference></ds:KeyInfo></ds:Signature>`;

  return `<soap:Envelope xmlns:soap="${SOAP_NS}" xmlns:wsa="${WSA_NS}" xmlns:wcf="${WCF_NS}">
  <soap:Header>
    <wsse:Security xmlns:wsse="${WSSE_NS}" xmlns:wsu="${WSU_NS}" soap:mustUnderstand="1">
      <wsu:Timestamp wsu:Id="${timestampId}">
        <wsu:Created>${created.toISOString()}</wsu:Created>
        <wsu:Expires>${expires.toISOString()}</wsu:Expires>
      </wsu:Timestamp>
      <wsse:BinarySecurityToken wsu:Id="${bstId}" ValueType="${X509_VALUE_TYPE}" EncodingType="${BASE64_ENCODING_TYPE}">${certB64}</wsse:BinarySecurityToken>
      ${signatureXml}
    </wsse:Security>
    <wsa:Action>${actionValue}</wsa:Action>
    <wsa:To wsu:Id="${toId}" xmlns:wsu="${WSU_NS}">${toValue}</wsa:To>
  </soap:Header>
  <soap:Body>
    ${input.bodyXml}
  </soap:Body>
</soap:Envelope>`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
