/** Consulta a la DIAN, vía el mismo web service SOAP que ya usa el resto de
 * esta integración (`WcfDianCustomerServices`), qué resoluciones de
 * numeración están vigentes HOY para el NIT del tenant -- operación
 * `GetNumberingRange`. Pedido explícito del usuario 2026-09-09: "hay
 * proveedores que solo asignando el rango... ya detectan la resolución" --
 * esto es exactamente ese mecanismo, atado a un botón manual en
 * Integraciones ("por ahora", decisión explícita del usuario, no
 * automático todavía).
 *
 * Mismo patrón de envío que sendToDian.ts/sendInvoiceToDian.ts (certificado
 * + mTLS + sobre SOAP firmado con wsSecuritySoap.ts) pero sin construir
 * ningún XML de factura.
 *
 * Contrato REAL confirmado contra el WSDL público
 * (https://vpfe-hab.dian.gov.co/WcfDianCustomerServices.svc?singleWsdl,
 * 2026-09-09) -- primera versión de este archivo había adivinado mal el
 * nombre de la operación (`GetNumberingRangeAsync`, que no existe -- dio
 * "ContractFilter mismatch" en vivo) y se corrigió acá con los 15 nombres
 * reales de operación del WSDL. El nombre correcto es `GetNumberingRange`
 * (sin "Async" -- a diferencia de SendTestSetAsync/SendBillAsync, esta no
 * lleva ese sufijo). Request: los 3 parámetros
 * (accountCode/accountCodeT/softwareCode) figuran como "Optional" en el
 * XSD, pero el TEXTO del Anexo Técnico (numeral 7.15.2, tabla de la
 * página 357) marca los tres como "R" -- requeridos -- y la DIAN los
 * exige de verdad, uno por uno, a medida que se mandan vacíos:
 * - `accountCode` = NIT del obligado a facturar (el tenant,
 *   `tenants.document_number`, sin dígito de verificación, el mismo valor
 *   que ya se usa como `documentNumber` del vendedor en
 *   buildInvoiceXml.ts). Omitirlo dio en vivo "NIT de la empresa no
 *   informado en accountCode".
 * - `accountCodeT` = NIT del DUEÑO DEL SOFTWARE. Se venía omitiendo, y la
 *   DIAN respondió en vivo (2026-09-10) "El código del software no
 *   corresponde al NIT: ." -- con la cadena vacía justo después de los
 *   dos puntos, que es exactamente el accountCodeT que nunca se mandó: la
 *   DIAN valida el softwareCode contra el dueño declarado ahí, y contra un
 *   dueño vacío no hay software que corresponda. En el modelo de esta
 *   plataforma (`dian_directo` = "software propio": cada tenant registra
 *   su propio software y `sts:SoftwareProvider/ProviderID` lleva su propio
 *   NIT) el dueño del software ES el tenant, así que va el mismo NIT que
 *   accountCode. El día que Lexy se registre como Proveedor Tecnológico
 *   este campo pasa a ser el NIT de Lexy mientras accountCode sigue siendo
 *   el del tenant -- son distintos justamente en ese escenario.
 * - `softwareCode` = `tenant_dian_profile.software_id`.
 * Response:
 * `GetNumberingRangeResponse > GetNumberingRangeResult` (tipo
 * `NumberRangeResponseList`) con `OperationCode`/`OperationDescription` +
 * `ResponseList` (array de `NumberRangeResponse`, con `ResolutionNumber`/
 * `ResolutionDate`/`Prefix`/`FromNumber`/`ToNumber`/`ValidDateFrom`/
 * `ValidDateTo`/`TechnicalKey`) -- nombres de campo verbatim del XSD, ya
 * usados como primer candidato en `parseNumberingRanges` de abajo.
 *
 * El parseo sigue siendo namespace-agnóstico (mismo truco que el
 * fault-matching de sendCreditNoteToDian.ts) porque, aunque ya se conocen
 * los nombres de elemento reales, la DIAN no es consistente entre
 * operaciones/ambientes con qué PREFIJO de namespace les antepone. */
import { buildSignedSoapEnvelope } from "./wsSecuritySoap.ts";
import { loadTenantCertificate, createMtlsClient } from "./dianClient.ts";

const ACTION = "http://wcf.dian.colombia/IWcfDianCustomerServices/GetNumberingRange";

export interface DianNumberingRange {
  resolutionNumber: string | null;
  prefix: string | null;
  rangeFrom: number | null;
  rangeTo: number | null;
  validFrom: string | null;
  validUntil: string | null;
  technicalKey: string | null;
}

export interface GetNumberingRangeResult {
  httpStatus: number;
  responseBody: string;
  ranges: DianNumberingRange[];
  faultReason: string | null;
  /** OperationDescription del propio GetNumberingRangeResult -- distinto de
   * un fault SOAP: la llamada respondió bien pero la DIAN puede explicar acá
   * por qué `ranges` vino vacío (ej. "no hay rangos activos para este
   * software"). Solo informativo, nunca bloquea. */
  operationDescription: string | null;
}

/** Trae las resoluciones de numeración vigentes del tenant `tenantId`
 * directo desde la DIAN. Lanza si falta configuración básica (perfil DIAN,
 * certificado) -- eso es un error real de setup, no algo que la DIAN pueda
 * resolver. Un fault SOAP de la DIAN misma (ej. NIT sin numeración
 * habilitada) NO lanza -- vuelve como `faultReason`, mismo criterio que
 * sendInvoiceToDian/sendCreditNoteToDian (un rechazo de negocio no es una
 * excepción de la llamada). */
// deno-lint-ignore no-explicit-any
export async function getTenantNumberingRangeFromDian(adminClient: any, tenantId: string): Promise<GetNumberingRangeResult> {
  const { data: profile, error: profileError } = await adminClient
    .from("tenant_dian_profile")
    .select("webservice_url, software_id")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (profileError || !profile) throw new Error("Este tenant no tiene perfil DIAN configurado.");
  if (!profile.webservice_url) {
    throw new Error("Falta la URL del web service en la configuración DIAN de este tenant (Integraciones).");
  }

  const { data: tenant, error: tenantError } = await adminClient
    .from("tenants")
    .select("document_number")
    .eq("id", tenantId)
    .maybeSingle();
  if (tenantError || !tenant?.document_number) {
    throw new Error("Falta el NIT del tenant (Configuración de la empresa) -- la DIAN lo exige para esta consulta.");
  }

  const cert = await loadTenantCertificate(adminClient, tenantId);

  const nit = escapeXml(String(tenant.document_number));
  const accountCodeXml = `<wcf:accountCode>${nit}</wcf:accountCode>`;
  // Mismo NIT que accountCode: en "software propio" el dueño del software
  // es el propio tenant -- ver el comentario de cabecera.
  const accountCodeTXml = `<wcf:accountCodeT>${nit}</wcf:accountCodeT>`;
  const softwareCodeXml = profile.software_id ? `<wcf:softwareCode>${escapeXml(String(profile.software_id))}</wcf:softwareCode>` : "";
  const bodyXml = `<wcf:GetNumberingRange xmlns:wcf="http://wcf.dian.colombia">${accountCodeXml}${accountCodeTXml}${softwareCodeXml}</wcf:GetNumberingRange>`;
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
  const ranges = faultReason ? [] : parseNumberingRanges(responseBody);
  const operationDescription = faultReason ? null : (extractAllAny(responseBody, ["OperationDescription"])[0] ?? null);

  return { httpStatus, responseBody, ranges, faultReason, operationDescription };
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Extrae TODAS las apariciones de un elemento por su nombre local,
 * ignorando el prefijo de namespace (`a:Prefix`, `ns2:Prefix`, `Prefix`
 * pelado -- la DIAN no es consistente entre operaciones/ambientes con qué
 * prefijo usa, mismo motivo documentado en wsSecuritySoap.ts). */
function extractAll(xml: string, localName: string): string[] {
  const re = new RegExp(`<(?:[A-Za-z0-9]+:)?${localName}(?:\\s[^>]*)?>([^<]*)<\\/(?:[A-Za-z0-9]+:)?${localName}>`, "g");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

/** Prueba una lista de nombres candidatos para el mismo campo lógico y se
 * queda con el primero que de verdad aparece en la respuesta -- ver el
 * comentario grande de cabecera del archivo para el porqué de esta
 * tolerancia. */
function extractAllAny(xml: string, candidates: string[]): string[] {
  for (const name of candidates) {
    const found = extractAll(xml, name);
    if (found.length > 0) return found;
  }
  return [];
}

function parseNumberingRanges(xml: string): DianNumberingRange[] {
  const prefixes = extractAllAny(xml, ["Prefix"]);
  const resolutionNumbers = extractAllAny(xml, ["ResolutionNumber", "AuthorizationNumber"]);
  const rangeFroms = extractAllAny(xml, ["FromNumber", "RangeFrom", "NumberFrom"]);
  const rangeTos = extractAllAny(xml, ["ToNumber", "RangeTo", "NumberTo"]);
  const validFroms = extractAllAny(xml, ["ValidDateFrom", "DateFrom"]);
  const validUntils = extractAllAny(xml, ["ValidDateTo", "DateTo"]);
  const technicalKeys = extractAllAny(xml, ["TechnicalKey"]);

  const count = Math.max(prefixes.length, resolutionNumbers.length, rangeFroms.length, rangeTos.length);
  const ranges: DianNumberingRange[] = [];
  for (let i = 0; i < count; i++) {
    ranges.push({
      prefix: prefixes[i] ?? null,
      resolutionNumber: resolutionNumbers[i] ?? null,
      rangeFrom: rangeFroms[i] ? Number(rangeFroms[i]) : null,
      rangeTo: rangeTos[i] ? Number(rangeTos[i]) : null,
      validFrom: validFroms[i] ?? null,
      validUntil: validUntils[i] ?? null,
      technicalKey: technicalKeys[i] ?? null,
    });
  }
  return ranges;
}
