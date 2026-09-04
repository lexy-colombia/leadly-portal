/** Piezas compartidas entre el envío de prueba (sendToDian.ts,
 * SendTestSetAsync con datos sintéticos) y el envío real de una factura ya
 * existente (sendInvoiceToDian.ts, SendTestSetAsync/SendBillAsync con datos
 * reales de sales_invoices) -- carga del certificado del tenant y armado
 * del cliente HTTP con mTLS. */
import { parsePkcs12 } from "./certificate.ts";
import { resolveTenantIntegrationCredential, makeIntegrationSecretGetter } from "../integrations/credentials.ts";

const PROVIDER_KEY = "dian_directo";

export interface TenantCertificate {
  privateKey: CryptoKey;
  privateKeyPkcs8Der: ArrayBuffer;
  certificateDer: ArrayBuffer;
  subjectCommonName: string | null;
  validFrom: Date;
  validTo: Date;
}

/** Descarga y parsea el certificado real del tenant (bucket privado
 * tenant-certificates) -- lanza con mensaje claro si algo falta, nunca
 * intenta adivinar o usar un certificado de otro tenant. */
// deno-lint-ignore no-explicit-any
export async function loadTenantCertificate(adminClient: any, tenantId: string): Promise<TenantCertificate> {
  const credential = await resolveTenantIntegrationCredential(adminClient, tenantId, PROVIDER_KEY);
  const config = credential.config as { storage_path?: string };
  if (!config.storage_path) {
    throw new Error("Este tenant todavía no cargó su certificado digital (.p12/.pfx) en Integraciones.");
  }

  const getSecret = makeIntegrationSecretGetter(adminClient, credential.id);
  const password = await getSecret("certificate_password");
  if (!password) throw new Error("Falta la contraseña del certificado digital en Integraciones.");

  const { data: fileData, error: downloadError } = await adminClient.storage
    .from("tenant-certificates")
    .download(config.storage_path);
  if (downloadError || !fileData) {
    throw new Error(`No se pudo descargar el certificado del storage: ${downloadError?.message ?? "archivo no encontrado"}`);
  }
  const fileBytes = new Uint8Array(await fileData.arrayBuffer());

  return await parsePkcs12(fileBytes, password);
}

export function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function pemWrap(label: string, der: ArrayBuffer): string {
  const b64 = uint8ToBase64(new Uint8Array(der));
  const lines = b64.match(/.{1,64}/g) ?? [b64];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----`;
}

/** Cliente HTTP con certificado de cliente (mTLS) -- confirmado que el
 * runtime real de Edge Functions lo soporta (Deno.createHttpClient con
 * cert/key en PEM), ver comentario de cabecera en dian-submit/index.ts. */
// deno-lint-ignore no-explicit-any
export function createMtlsClient(cert: TenantCertificate): any {
  // deno-lint-ignore no-explicit-any
  return (Deno as any).createHttpClient({
    cert: pemWrap("CERTIFICATE", cert.certificateDer),
    key: pemWrap("PRIVATE KEY", cert.privateKeyPkcs8Der),
  });
}
