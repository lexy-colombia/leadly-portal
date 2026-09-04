import { supabase } from '../supabaseClient'

const CERTIFICATE_MAX_BYTES = 512 * 1024 // mismo límite que el bucket tenant-certificates (524288 bytes)
const CERTIFICATE_EXTENSIONS = ['p12', 'pfx']

export type CertificateValidationError = 'einvoicing.certificate.error.invalidType' | 'einvoicing.certificate.error.tooLarge'

/** El mime-type de un .p12/.pfx no es confiable entre navegadores/SO --
 * validar por extensión, mismo criterio documentado en el plan de esta
 * fase. */
export function validateCertificateFile(file: File): CertificateValidationError | null {
  const ext = file.name.split('.').pop()?.toLowerCase()
  if (!ext || !CERTIFICATE_EXTENSIONS.includes(ext)) return 'einvoicing.certificate.error.invalidType'
  if (file.size > CERTIFICATE_MAX_BYTES) return 'einvoicing.certificate.error.tooLarge'
  return null
}

export interface UploadedCertificate {
  storage_path: string
  certificate_filename: string
}

/** Sube el certificado digital al bucket privado tenant-certificates (RLS:
 * solo tenant_admin del propio tenant o superadmin, ver
 * 20260903105000_tenant_certificates_bucket.sql). Nombre de archivo
 * aleatorio, mismo criterio que crm-attachments -- no es un slot fijo como
 * tenant-logos, un tenant puede tener certificados viejos huérfanos en el
 * bucket si reemplaza el suyo (no se borran automáticamente). */
export async function uploadCertificateFile(tenantId: string, file: File): Promise<UploadedCertificate> {
  const validationError = validateCertificateFile(file)
  if (validationError) throw new Error(validationError)

  const ext = file.name.split('.').pop()!.toLowerCase()
  const path = `${tenantId}/${crypto.randomUUID()}.${ext}`
  const { error } = await supabase.storage.from('tenant-certificates').upload(path, file, { contentType: file.type || 'application/octet-stream' })
  if (error) throw error

  return { storage_path: path, certificate_filename: file.name }
}
