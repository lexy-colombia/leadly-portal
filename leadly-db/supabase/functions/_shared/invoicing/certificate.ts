/** Extracción de clave privada + certificado desde un archivo .p12/.pfx --
 * Fase 2, pieza de firma digital.
 *
 * Usa `node-forge` (vía npm:), NO `pkijs`/WebCrypto directo -- decisión
 * tomada después de encontrar en vivo que el .p12 real de un tenant
 * (Barriles de la Sexta) usa el esquema de cifrado PKCS12 clásico
 * (`pbeWithSHA1And40BitRC2-CBC`, típico de lo que exportan por defecto
 * Certicámara/GSE/Andes SCD) -- WebCrypto (y por lo tanto `pkijs`, que
 * delega el desencriptado a `crypto.subtle`) NO implementa RC2 ni el KDF
 * legacy de PKCS12 Appendix B, así que un tenant con un certificado real
 * típico nunca podía pasar de "no se pudo desencriptar el contenido".
 * Pedirle a cada tenant que reconvierta su certificado a mano con OpenSSL
 * antes de subirlo no es una solución aceptable para un producto
 * multi-tenant -- el sistema tiene que bancarse cualquier .p12 real tal
 * cual lo entrega la entidad certificadora. `node-forge` implementa RC2/DES3
 * y el KDF de PKCS12 en JS puro, sin depender de qué algoritmos exponga el
 * runtime -- verificado en el runtime real de Deno con un .p12 de prueba
 * generado a propósito con el esquema legacy (`openssl pkcs12 -legacy`) y
 * con uno moderno (AES) -- ambos abren igual. Solo el parseo/desencriptado
 * del contenedor usa node-forge; la clave extraída se reimporta como
 * CryptoKey nativo (`crypto.subtle.importKey`) para firmar -- ahí sí se usa
 * WebCrypto normal, RSASSA-PKCS1-v1_5/SHA-256 es un algoritmo estándar que
 * no tiene este problema.
 *
 * Deliberadamente NO valida qué esquema de cifrado tenía el .p12 original
 * ni informa cuál era -- para el tenant es indistinto, el sistema abre
 * cualquiera de los dos por igual.
 */
export interface ParsedCertificate {
  privateKey: CryptoKey;
  privateKeyPkcs8Der: ArrayBuffer;
  certificateDer: ArrayBuffer;
  subjectCommonName: string | null;
  validFrom: Date;
  validTo: Date;
}

/** Lanza un Error con mensaje claro si la contraseña es incorrecta o el
 * archivo no es un .p12/.pfx válido -- nunca falla en silencio, esto se usa
 * para firmar documentos fiscales reales. */
export async function parsePkcs12(fileBytes: Uint8Array, password: string): Promise<ParsedCertificate> {
  const forge = (await import("npm:node-forge@1")).default;

  let binary = "";
  for (let i = 0; i < fileBytes.length; i++) binary += String.fromCharCode(fileBytes[i]);

  let asn1: unknown;
  try {
    asn1 = forge.asn1.fromDer(binary);
  } catch (_err) {
    throw new Error("El archivo no es un certificado .p12/.pfx válido (no se pudo parsear como ASN.1).");
  }

  // deno-lint-ignore no-explicit-any
  let p12: any;
  try {
    // deno-lint-ignore no-explicit-any
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1 as any, false, password);
  } catch (_err) {
    throw new Error("No se pudo abrir el certificado -- la contraseña es incorrecta o el archivo está dañado.");
  }

  const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
  const keyBag = keyBags[forge.pki.oids.pkcs8ShroudedKeyBag]?.[0];
  if (!keyBag?.key) throw new Error("El certificado no contiene una clave privada.");

  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });
  const certBag = certBags[forge.pki.oids.certBag]?.[0]; // primer certificado = el del titular, no la cadena
  if (!certBag?.cert) throw new Error("El certificado no contiene un certificado X.509.");

  const pkcs8Binary = forge.asn1.toDer(forge.pki.wrapRsaPrivateKey(forge.pki.privateKeyToAsn1(keyBag.key))).getBytes();
  const privateKeyPkcs8Der = binaryStringToArrayBuffer(pkcs8Binary);

  const privateKey = await crypto.subtle.importKey("pkcs8", privateKeyPkcs8Der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);

  const certificateDer = binaryStringToArrayBuffer(forge.asn1.toDer(forge.pki.certificateToAsn1(certBag.cert)).getBytes());

  const cnField = certBag.cert.subject?.getField("CN");
  const subjectCommonName: string | null = cnField?.value ?? null;
  const validFrom: Date = certBag.cert.validity.notBefore;
  const validTo: Date = certBag.cert.validity.notAfter;

  return { privateKey, privateKeyPkcs8Der, certificateDer, subjectCommonName, validFrom, validTo };
}

function binaryStringToArrayBuffer(binary: string): ArrayBuffer {
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
