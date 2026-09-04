/** Orquesta el envío de un documento de PRUEBA SINTÉTICO a la DIAN
 * (SendTestSetAsync, ambiente de habilitación) -- usado para el smoke test
 * inicial contra el servidor real (ver comentario grande abajo) y para que
 * un tenant pueda probar que su certificado/configuración funcionan sin
 * gastar una factura real. El envío de una factura REAL ya emitida vive en
 * sendInvoiceToDian.ts -- separado a propósito, ese no inventa datos.
 *
 * Formato de transporte CONFIRMADO EN VIVO contra
 * https://vpfe-hab.dian.gov.co/WcfDianCustomerServices.svc (2026-09-03):
 * NO es MTOM/XOP (esa variante dio 415 Unsupported Media Type) -- es
 * `Content-Type: application/soap+xml; charset=utf-8` con el ZIP en base64
 * DIRECTO como texto de `<wcf:contentFile>`. Con esa forma el servidor real
 * ya devuelve un SOAP fault bien formado (`s:Client`, sin más detalle) en
 * vez de rechazar el formato -- consistente con que solo falta un
 * certificado real y registrado (se probó con uno de descarte). Sin Basic
 * Auth -- no dio 401, así que no parece hacer falta. */
import { buildInvoiceXml, type BuildInvoiceXmlInput } from "./buildInvoiceXml.ts";
import { signInvoiceXml } from "./signInvoiceXml.ts";
import { buildInvoiceZip } from "./zip.ts";
import { buildSignedSoapEnvelope } from "./wsSecuritySoap.ts";
import { resolveTenantIntegrationCredential, makeIntegrationSecretGetter } from "../integrations/credentials.ts";
import { loadTenantCertificate, createMtlsClient, uint8ToBase64 } from "./dianClient.ts";

const PROVIDER_KEY = "dian_directo";

export interface SendTestSetResult {
  httpStatus: number;
  httpStatusText: string;
  responseBody: string;
  zipKey: string | null;
  invoiceId: string;
  cufe: string;
  certificateSubject: string | null;
  certificateValidFrom: string;
  certificateValidTo: string;
}

/** Arma y envía UN documento de prueba sintético a SendTestSetAsync, usando
 * los datos reales de perfil/resolución ya cargados por el tenant en
 * tenant_dian_profile -- no un pedido real (la habilitación es sobre
 * documentos de muestra, no transacciones reales). Devuelve la respuesta
 * cruda del servidor (status + body) tal cual, sin interpretarla -- eso es
 * decisión de quien llama. */
export async function sendTestInvoiceToDian(
  // deno-lint-ignore no-explicit-any
  adminClient: any,
  tenantId: string,
): Promise<SendTestSetResult> {
  const { data: profile, error: profileError } = await adminClient
    .from("tenant_dian_profile")
    .select("test_set_id, webservice_url, software_id, city, resolution_number, resolution_prefix, resolution_range_from, resolution_range_to, resolution_valid_from, resolution_valid_until")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (profileError || !profile) throw new Error("Este tenant no tiene perfil DIAN configurado.");
  if (!profile.test_set_id) throw new Error("Falta el Test Set ID en la configuración DIAN de este tenant.");
  if (!profile.webservice_url) throw new Error("Falta la URL del web service en la configuración DIAN de este tenant.");
  if (!profile.software_id) throw new Error("Falta el Software ID en la configuración DIAN de este tenant.");
  if (!profile.resolution_prefix || !profile.resolution_range_from) {
    throw new Error("Falta la resolución de facturación (prefijo/rango) en la configuración DIAN de este tenant.");
  }

  const credential = await resolveTenantIntegrationCredential(adminClient, tenantId, PROVIDER_KEY);
  const getSecret = makeIntegrationSecretGetter(adminClient, credential.id);
  const softwarePin = await getSecret("software_pin");
  const technicalKey = await getSecret("technical_key");
  if (!softwarePin) throw new Error("Falta el PIN del software en Integraciones.");
  if (!technicalKey) throw new Error("Falta la clave técnica en Integraciones.");

  const { data: tenant, error: tenantError } = await adminClient
    .from("tenants")
    .select("legal_name, document_number, country, state_province")
    .eq("id", tenantId)
    .maybeSingle();
  if (tenantError || !tenant?.legal_name || !tenant?.document_number) {
    throw new Error("Falta razón social / NIT del tenant (Configuración de la empresa).");
  }

  const cert = await loadTenantCertificate(adminClient, tenantId);

  const invoiceNumber = String(profile.resolution_range_from);
  const invoiceId = `${profile.resolution_prefix}${invoiceNumber}`;
  const now = new Date();

  const xmlInput: BuildInvoiceXmlInput = {
    invoiceId,
    issueDate: now.toISOString().slice(0, 10),
    issueTime: now.toISOString().slice(11, 19) + "-05:00",
    currency: "COP",
    environment: 2,
    seller: {
      legalName: tenant.legal_name,
      documentTypeCode: "31",
      documentNumber: tenant.document_number,
      addressLine: "N/A",
      city: profile.city ?? "N/A",
      stateProvince: tenant.state_province ?? "N/A",
      countryCode: "CO",
    },
    buyer: {
      legalName: "Cliente de Prueba Habilitación",
      documentTypeCode: "13",
      documentNumber: "1000000000",
      addressLine: "N/A",
      city: "N/A",
      stateProvince: "N/A",
      countryCode: "CO",
    },
    lines: [
      {
        id: 1,
        description: "Producto de prueba (habilitación DIAN)",
        quantity: 1,
        unitPrice: 10000,
        lineExtensionAmount: 10000,
        tax: { code: "01", rate: 19, taxableAmount: 8403.36, taxAmount: 1596.64 },
      },
    ],
    withholdings: [],
    resolution: {
      number: profile.resolution_number ?? "",
      prefix: profile.resolution_prefix,
      rangeFrom: String(profile.resolution_range_from),
      rangeTo: String(profile.resolution_range_to ?? profile.resolution_range_from),
      validFrom: profile.resolution_valid_from ?? now.toISOString().slice(0, 10),
      validUntil: profile.resolution_valid_until ?? now.toISOString().slice(0, 10),
    },
    softwareId: profile.software_id,
    softwarePin,
    technicalKey,
    authorizationProviderNit: "800197268",
  };

  const { xml: unsignedXml, cufe } = await buildInvoiceXml(xmlInput);
  const signedInvoiceXml = await signInvoiceXml({ unsignedXml, privateKey: cert.privateKey, certificateDer: cert.certificateDer });

  const zipFileName = `${invoiceId}.zip`;
  const zipBytes = buildInvoiceZip([{ fileName: `${invoiceId}.xml`, content: new TextEncoder().encode(signedInvoiceXml) }]);
  const zipBase64 = uint8ToBase64(zipBytes);

  const bodyXml = `<wcf:SendTestSetAsync xmlns:wcf="http://wcf.dian.colombia"><wcf:fileName>${zipFileName}</wcf:fileName><wcf:contentFile>${zipBase64}</wcf:contentFile><wcf:testSetId>${profile.test_set_id}</wcf:testSetId></wcf:SendTestSetAsync>`;

  const envelope = await buildSignedSoapEnvelope({
    action: "http://wcf.dian.colombia/IWcfDianCustomerServices/SendTestSetAsync",
    to: profile.webservice_url,
    bodyXml,
    privateKey: cert.privateKey,
    certificateDer: cert.certificateDer,
  });

  const client = createMtlsClient(cert);
  try {
    const resp = await fetch(profile.webservice_url, {
      method: "POST",
      client,
      headers: {
        "Content-Type": "application/soap+xml; charset=utf-8",
        SOAPAction: '"http://wcf.dian.colombia/IWcfDianCustomerServices/SendTestSetAsync"',
      },
      body: envelope,
    });
    const responseBody = await resp.text();
    const zipKeyMatch = responseBody.match(/<b:ZipKey>([^<]+)<\/b:ZipKey>/);
    return {
      httpStatus: resp.status,
      httpStatusText: resp.statusText,
      responseBody,
      zipKey: zipKeyMatch ? zipKeyMatch[1] : null,
      invoiceId,
      cufe,
      certificateSubject: cert.subjectCommonName,
      certificateValidFrom: cert.validFrom.toISOString(),
      certificateValidTo: cert.validTo.toISOString(),
    };
  } finally {
    client.close?.();
  }
}
