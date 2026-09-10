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
 * mandar cualquier factura real.
 *
 * ⚠️ RONDA 2026-09-10, contra el rechazo real y persistente ZE02 ("Valor de
 * la Firma inválido") -- consultado el Anexo Técnico 1.9 oficial (numeral
 * 6.5.10 y 8.8.5) en vez de seguir probando a ciegas.
 *
 * Causa real #1, ENCONTRADA Y CORREGIDA (sigue vigente en el código de más
 * abajo): faltaba la SEGUNDA de las tres `ds:Reference` que exige el Anexo
 * (DC02/DC10-DC12) -- el digest de `ds:KeyInfo`. `xadesjs` nunca la agrega
 * sola (solo agrega la de `SignedProperties`), así que `SignedInfo` quedaba
 * con 2 referencias en vez de 3. Confirmado contra el Anexo y contra el
 * ejemplo oficial Generica.xml.
 *
 * Hipótesis #2, PROBADA Y DESCARTADA -- no la repitas: con la referencia de
 * arriba ya agregada, un envío real SIGUIÓ rechazando ZE02. Se sospechó que
 * `xmldsigjs` canonicalizaba `SignedInfo`/`KeyInfo`/`SignedProperties` mal
 * (inyectando los 9 namespaces de la raíz `Invoice` -- "atrae contexto de
 * ancestros", comportamiento que el propio estándar respalda: W3C XMLDSig
 * Core 7.3) y se probó forzar la canonicalización "mínima" (como si cada
 * elemento fuera un documento standalone). Se DESCARTÓ con evidencia dura:
 * se consiguió una factura real ya ACEPTADA por la DIAN (de otro software,
 * Jerónimo Martins Colombia) y se verificaron sus tres valores (digest de
 * KeyInfo, digest de SignedProperties, SignatureValue) bajo ambas
 * convenciones -- los tres coinciden EXACTO con "atrae contexto" (la que
 * `xmldsigjs` ya usa por defecto) y NINGUNO con la forma mínima. La
 * convención que ya usa este archivo es la correcta.
 *
 * Causa real #2, ENCONTRADA Y CORREGIDA (la de fondo, tras 9 rechazos
 * idénticos): la primera `ds:Reference` salía SIN el atributo `URI`. El
 * Anexo exige `URI=""` (DC05) y el estándar XMLDSig le da un significado
 * completamente distinto a omitirlo -- la DIAN no podía resolver qué se
 * había firmado y daba la firma por inválida. Se encontró volcando el XML
 * real que generábamos (ver `debug_dump_invoice_xml` en dian-submit) y
 * comparándolo contra una factura real ya aceptada. Ninguna verificación
 * propia lo detectaba porque todas asumían "documento completo" sin mirar
 * ese atributo -- si volvés a tocar esta parte, verificá SIEMPRE contra un
 * documento real aceptado, no solo contra la autoconsistencia interna. */
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

/** Sufijo aleatorio para el `Id` de `KeyInfo` (ver el comentario en
 * `signInvoiceXml` sobre la referencia faltante) -- hex, nunca empieza con
 * un dígito real de por sí (el prefijo "xmldsig-" ya lo garantiza), válido
 * como NCName de XML. */
function randomHex(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
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

  // Causa real de ZE02 ("Valor de la Firma inválido"), confirmada contra el
  // Anexo Técnico 1.9 (numeral 6.5.10, reglas DC02/DC10-DC12) y verificada
  // con una firma de prueba fuera de este archivo: `ds:SignedInfo` DEBE
  // contener exactamente TRES `ds:Reference` -- (1) el documento completo
  // (enveloped), (2) un digest de `ds:KeyInfo` (URI="#{id}-KeyInfo"), (3) un
  // digest de `xades:SignedProperties`. `xadesjs` arma automáticamente la
  // (1) (la que pasamos abajo) y la (3) (la agrega sola al procesar
  // `signingCertificate`/`policy`/`signerRole`), pero NUNCA arma la (2) --
  // no existe ningún código en la librería que la agregue. Sin ella,
  // `SignedInfo` queda con solo 2 referencias: la firma que se calcula es
  // internamente autoconsistente (por eso `verifySignedInvoiceXml` de más
  // abajo siempre dio `true`) pero no es la que la DIAN reconstruye al
  // validar el documento recibido -- de ahí que un `crypto.subtle.verify`
  // externo sobre el `SignedInfo` tal cual queda en el XML final SIEMPRE
  // daba `false`, confirmado con un certificado de prueba fuera de este
  // pipeline. Se agrega a mano: se le da un `Id` al `KeyInfo` ANTES de
  // firmar y se referencia esa misma id sin `transforms` -- sin transforms
  // explícitos, `xmldsigjs` aplica C14N (no exclusivo, igual que
  // `CanonicalizationMethod`) como transform implícito por defecto, que es
  // exactamente lo que muestra el ejemplo oficial Generica.xml para esa
  // misma referencia.
  const keyInfoId = `xmldsig-${randomHex(8)}-KeyInfo`;
  // deno-lint-ignore no-explicit-any
  (signedXml as any).XmlSignature.KeyInfo = new (xmldsig as any).KeyInfo();
  (signedXml as any).XmlSignature.KeyInfo.Id = keyInfoId;

  await signedXml.Sign(
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    input.privateKey,
    doc,
    {
      x509: [certB64],
      // Un solo transform ("enveloped") en la referencia del documento
      // completo -- confirmado contra Generica.xml y contra el Anexo
      // Técnico (DC06/DC07: el grupo Transforms de esa referencia trae un
      // único TransForm, el enveloped-signature). La referencia a KeyInfo
      // (ver arriba) va sin transforms -- Generica.xml tampoco le pone
      // ninguno.
      references: [
        // `uri: ""` es OBLIGATORIO y NO es lo mismo que omitirlo: el Anexo
        // Técnico exige `URI=""` en esta referencia (regla DC05, "debe
        // contener la información de la firma aplicada a todo el
        // documento... URI=''"), y el estándar XMLDSig le da un significado
        // COMPLETAMENTE distinto a una URI ausente (referencia a un objeto
        // que la aplicación define, no resoluble) que a `URI=""` (el
        // documento completo). `xmldsigjs` solo escribe el atributo si se
        // le pasa explícitamente (`Reference.Uri` no tiene defaultValue,
        // queda `undefined` y se omite al serializar).
        //
        // ESTA ERA LA CAUSA REAL DEL RECHAZO ZE02 ("Valor de la firma
        // inválido"), encontrada 2026-09-10 tras 9 rechazos idénticos:
        // nuestro XML salía con `<ds:Reference>` pelado, sin `URI`, así que
        // la DIAN no podía resolver qué se firmó y daba la firma por
        // inválida. Ninguna de nuestras verificaciones propias lo detectaba
        // porque todas asumían "documento completo" sin mirar el atributo.
        // Se encontró comparando byte a byte contra una factura real ya
        // ACEPTADA por la DIAN (de otro software), que sí trae `URI=""`.
        { id: `${keyInfoId.replace("-KeyInfo", "")}-ref0`, uri: "", hash: "SHA-256", transforms: ["enveloped"] },
        { hash: "SHA-256", uri: `#${keyInfoId}` },
      ],
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

  // RONDA 2026-09-10, revertida: se probó una hipótesis de que la DIAN
  // esperaba SignedInfo/KeyInfo/SignedProperties canonicalizados como
  // documentos independientes (namespaces mínimos, sin heredar nada de
  // `Invoice`) en vez de la convención por defecto de `xmldsigjs`
  // (namespaces de la raíz inyectados -- "atrae contexto de ancestros",
  // avalado por el propio estándar: W3C XMLDSig Core 7.3). Se verificó
  // DEFINITIVAMENTE contra una factura real ya ACEPTADA por la DIAN (de
  // otro software, compartida por el usuario -- Jerónimo Martins Colombia)
  // que la convención correcta es la que `xmldsigjs` ya usa por defecto
  // ("atrae contexto"): tanto los digests de KeyInfo/SignedProperties como
  // el valor final de la firma de ESA factura real coinciden exacto con
  // "atrae contexto" y NO con la forma mínima -- por eso no hace falta (ni
  // corresponde) recalcular nada acá, `Sign()` ya lo hace bien. El
  // rechazo ZE02 persistente contra un envío real con esta misma
  // convención (antes de probar -y descartar- la hipótesis mínima) sigue
  // sin explicación -- la causa real todavía no se encontró, ver el
  // comentario de cabecera del archivo para el estado de la investigación.

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
