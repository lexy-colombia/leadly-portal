/** Firma XAdES-EPES del XML de la factura -- Fase 2, última pieza antes del
 * envío por web service (que todavía no está construido).
 *
 * Probado de punta a punta en el runtime real de Deno con `pkijs`
 * (certificate.ts, extrae la clave privada del .p12) + `xmldsigjs`/`xadesjs`
 * (PeculiarVentures, vía npm:, corren nativos sobre crypto.subtle sin
 * ningún polyfill de Node) + `@xmldom/xmldom` (el único polyfill real que
 * hace falta -- Deno no trae DOMParser/XMLSerializer de fábrica, a
 * diferencia de un navegador).
 *
 * El hash de la política de firma (`SigPolicyHash`) está VERIFICADO: se
 * descargó el PDF real vigente
 * (https://facturaelectronica.dian.gov.co/politicadefirma/v2/politicadefirmav2.pdf)
 * y se calculó su SHA-256 -- no es un valor inventado ni copiado de una
 * fuente secundaria.
 *
 * ⚠️ Bug real encontrado y ya entendido en `xmldsigjs@2.8.8` (no en este
 * código): su transform `enveloped-signature`
 * (`xml/transforms/enveloped_signature.js::GetOutput`) solo busca y quita
 * `ds:Signature` entre los HIJOS DIRECTOS del nodo raíz -- no busca
 * recursivamente en todo el árbol. La DIAN exige que la firma quede
 * anidada 3 niveles adentro
 * (`Invoice/ext:UBLExtensions/ext:UBLExtension/ext:ExtensionContent/ds:Signature`,
 * confirmado contra el ejemplo oficial), así que el propio `Verify()` de
 * esa librería nunca encuentra la firma para quitarla y compara mal el
 * documento -- reporta "digest inválido" sobre una firma que en realidad
 * está bien.
 *
 * Se comprobó que esto NO afecta lo que se firma y se manda: al hacer la
 * misma comprobación a mano pero con una búsqueda recursiva real (ver
 * `verifySignedInvoiceXml` acá abajo), el digest recalculado coincide
 * exacto con el que quedó guardado en la firma -- la firma que produce
 * `signInvoiceXml` es correcta, solo el `Verify()` de la librería no sabe
 * buscarla en el lugar donde la DIAN exige que esté. Por eso este archivo
 * NO usa `SignedXml.Verify()` para nada -- implementa su propia
 * verificación (recursiva, sí funciona) como red de seguridad antes de
 * mandar cualquier factura real. */
import { DOMParser, XMLSerializer } from "npm:@xmldom/xmldom@0.8";
import * as xmldsig from "npm:xmldsigjs@2";
import * as xades from "npm:xadesjs@2";

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

/** Identificador de política de firma XAdES-EPES exigido por la DIAN --
 * ver comentario arriba sobre cómo se verificó el hash. */
export const DIAN_SIGNATURE_POLICY = {
  identifier: "https://facturaelectronica.dian.gov.co/politicadefirma/v2/politicadefirmav2.pdf",
  description: "Política de firma para facturas electrónicas de la República de Colombia.",
  hashAlgorithm: "SHA-256" as const,
  hashValueBase64: "dMoMvtcG5aIzgYo0tIsSQeVJBDnUnfSOfBpxXrmor0Y=",
};

export interface SignInvoiceXmlInput {
  /** XML sin firmar, tal cual lo devuelve buildInvoiceXml -- debe tener el
   * segundo <ext:UBLExtension><ext:ExtensionContent/></ext:UBLExtension>
   * vacío ya presente (ver comentario en buildInvoiceXml.ts). */
  unsignedXml: string;
  privateKey: CryptoKey;
  certificateDer: ArrayBuffer;
}

export async function signInvoiceXml(input: SignInvoiceXmlInput): Promise<string> {
  ensureEngine();

  const doc = new DOMParser().parseFromString(input.unsignedXml, "text/xml");

  // deno-lint-ignore no-explicit-any
  const extensionContents = doc.getElementsByTagNameNS("urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2", "ExtensionContent") as any;
  let signatureTarget: Element | null = null;
  for (let i = 0; i < extensionContents.length; i++) {
    const node = extensionContents[i];
    if (!node.firstChild) {
      signatureTarget = node; // el segundo ExtensionContent, vacío -- ahí va la firma
      break;
    }
  }
  if (!signatureTarget) throw new Error("El XML sin firmar no tiene el ExtensionContent vacío esperado para insertar la firma (ver buildInvoiceXml.ts).");

  const certB64 = bufToBase64(input.certificateDer);

  // deno-lint-ignore no-explicit-any
  const signedXml = new (xades as any).SignedXml(signatureTarget);
  await signedXml.Sign(
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    input.privateKey,
    doc,
    {
      x509: [certB64],
      references: [{ hash: "SHA-256", transforms: ["enveloped", "c14n"] }],
      signingCertificate: certB64,
      signingTime: { value: new Date() },
      policy: {
        identifier: {
          value: DIAN_SIGNATURE_POLICY.identifier,
          description: DIAN_SIGNATURE_POLICY.description,
        },
        hash: DIAN_SIGNATURE_POLICY.hashAlgorithm,
        digestValue: DIAN_SIGNATURE_POLICY.hashValueBase64,
      },
      signerRole: { claimed: ["supplier"] },
    },
  );

  // deno-lint-ignore no-explicit-any
  const signatureNode = (signedXml as any).XmlSignature.GetXml();
  signatureTarget.appendChild(doc.importNode ? doc.importNode(signatureNode, true) : signatureNode);

  return new XMLSerializer().serializeToString(doc);
}

/** Quita un ds:Signature del árbol buscando RECURSIVAMENTE (a diferencia
 * del transform enveloped-signature de xmldsigjs@2.8.8, que solo mira
 * hijos directos del nodo raíz -- ver comentario grande arriba). Devuelve
 * true si encontró y quitó uno. */
// deno-lint-ignore no-explicit-any
function removeSignatureRecursive(node: any): boolean {
  for (let i = 0; i < node.childNodes.length; i++) {
    const child = node.childNodes[i];
    if (child.nodeType === 1 && child.localName === "Signature" && child.namespaceURI === "http://www.w3.org/2000/09/xmldsig#") {
      node.removeChild(child);
      return true;
    }
    if (child.nodeType === 1 && removeSignatureRecursive(child)) return true;
  }
  return false;
}

/** Verificación propia del digest del documento completo (la referencia
 * URI="" con transforms enveloped-signature + C14N) -- NO usa
 * `SignedXml.Verify()` de xmldsigjs por el bug documentado arriba. Sirve
 * como red de seguridad antes de mandar una factura real: si esto no da
 * `true`, no hay que mandarla. No valida (todavía) la firma RSA en sí
 * sobre `SignedInfo`, ni los otros dos `ds:Reference` (SignedProperties,
 * KeyInfo) -- alcanza para confirmar que el contenido de la factura no se
 * corrompió entre firmar y serializar, que es el riesgo real que importa acá. */
export async function verifySignedInvoiceXml(signedXml: string): Promise<boolean> {
  const doc = new DOMParser().parseFromString(signedXml, "text/xml");

  const signedInfo = doc.getElementsByTagNameNS("http://www.w3.org/2000/09/xmldsig#", "SignedInfo")[0];
  if (!signedInfo) return false;
  const storedDigest = signedInfo.getElementsByTagNameNS("http://www.w3.org/2000/09/xmldsig#", "DigestValue")[0]?.textContent;
  if (!storedDigest) return false;

  const strippedDoc = new DOMParser().parseFromString(signedXml, "text/xml");
  const found = removeSignatureRecursive(strippedDoc.documentElement);
  if (!found) return false;

  ensureEngine();
  // deno-lint-ignore no-explicit-any
  const canonicalizer = new (xmldsig as any).XmlCanonicalizer(false, false);
  const canonicalized: string | ArrayBuffer = canonicalizer.Canonicalize(strippedDoc.documentElement);
  const bytes = typeof canonicalized === "string" ? new TextEncoder().encode(canonicalized) : canonicalized;
  const digestBuf = await crypto.subtle.digest("SHA-256", bytes);
  const recomputedDigest = bufToBase64(digestBuf);

  return recomputedDigest === storedDigest;
}
