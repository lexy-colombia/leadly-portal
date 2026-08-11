import { supabase } from '../supabaseClient'
import type { CrmAttachment } from '../../types/domain'
import { PQR_ATTACHMENT_ALLOWED_TYPES, PQR_ATTACHMENT_MAX_BYTES, TASK_ATTACHMENT_ALLOWED_TYPES, TASK_ATTACHMENT_MAX_BYTES } from '../referenceData'

const SIGNED_URL_TTL_SECONDS = 60 * 60

export function validatePqrAttachmentFile(file: File): string | null {
  if (!PQR_ATTACHMENT_ALLOWED_TYPES.includes(file.type)) return 'La imagen debe ser PNG, JPG o WEBP.'
  if (file.size > PQR_ATTACHMENT_MAX_BYTES) return 'La imagen no puede pesar más de 8MB.'
  return null
}

export function validateTaskAttachmentFile(file: File): string | null {
  if (!TASK_ATTACHMENT_ALLOWED_TYPES.includes(file.type)) return 'El archivo debe ser PNG, JPG, WEBP o PDF.'
  if (file.size > TASK_ATTACHMENT_MAX_BYTES) return 'El archivo no puede pesar más de 8MB.'
  return null
}

export interface UploadedMedia {
  storage_path: string
  mime_type: string
  size_bytes: number
}

/** Uploads a file to the private `crm-attachments` bucket under this
 * tenant's own folder (RLS-gated, see 20260804000019/20260806000012
 * migrations) -- callers must validate the file themselves first (each
 * attachment kind has its own allowed types/size, see
 * validatePqrAttachmentFile/validateTaskAttachmentFile). Random filename per
 * upload -- unlike tenant-logos there's no single slot to overwrite. */
async function uploadAttachmentFile(tenantId: string, file: File): Promise<UploadedMedia> {
  const ext = file.name.split('.').pop()?.toLowerCase() || 'jpg'
  const path = `${tenantId}/${crypto.randomUUID()}.${ext}`

  const { error: uploadError } = await supabase.storage.from('crm-attachments').upload(path, file, {
    contentType: file.type,
  })
  if (uploadError) throw uploadError

  return { storage_path: path, mime_type: file.type, size_bytes: file.size }
}

/** Uploads an agent-attached image and links it to a PQR or a seguimiento
 * (exactly one of the two, mirrors the DB check constraint). */
export async function uploadPqrAttachment(
  tenantId: string,
  file: File,
  target: { pqrId: string } | { pqrUpdateId: string },
): Promise<CrmAttachment> {
  const validationError = validatePqrAttachmentFile(file)
  if (validationError) throw new Error(validationError)
  const uploaded = await uploadAttachmentFile(tenantId, file)

  const {
    data: { user },
  } = await supabase.auth.getUser()

  const { data, error } = await supabase
    .from('crm_attachments')
    .insert({
      tenant_id: tenantId,
      pqr_id: 'pqrId' in target ? target.pqrId : null,
      pqr_update_id: 'pqrUpdateId' in target ? target.pqrUpdateId : null,
      storage_path: uploaded.storage_path,
      mime_type: uploaded.mime_type,
      size_bytes: uploaded.size_bytes,
      original_filename: file.name || null,
      created_by: user?.id ?? null,
    })
    .select()
    .single()
  if (error) throw error
  return data
}

/** Uploads an image the agent is about to send directly in the human-mode
 * chat -- not linked to any PQR/seguimiento, whatsapp-send-human just reads
 * it back by storage_path to build the outbound WhatsApp message. */
export async function uploadChatImage(tenantId: string, file: File): Promise<UploadedMedia> {
  const validationError = validatePqrAttachmentFile(file)
  if (validationError) throw new Error(validationError)
  return uploadAttachmentFile(tenantId, file)
}

/** Uploads a file (image or PDF -- a task attachment is very likely a
 * proposal/quote sent to a client) and links it to a task. Only meaningful
 * for an existing task: crm_attachments.task_id needs a real row to point
 * at, so TaskDrawer only offers this once the task has already been saved. */
export async function uploadTaskAttachment(tenantId: string, file: File, taskId: string): Promise<CrmAttachment> {
  const validationError = validateTaskAttachmentFile(file)
  if (validationError) throw new Error(validationError)
  const uploaded = await uploadAttachmentFile(tenantId, file)

  const {
    data: { user },
  } = await supabase.auth.getUser()

  const { data, error } = await supabase
    .from('crm_attachments')
    .insert({
      tenant_id: tenantId,
      task_id: taskId,
      storage_path: uploaded.storage_path,
      mime_type: uploaded.mime_type,
      size_bytes: uploaded.size_bytes,
      original_filename: file.name || null,
      created_by: user?.id ?? null,
    })
    .select()
    .single()
  if (error) throw error
  return data
}

/** Uploads an agent-attached image and links it to a venta/cotización
 * comment -- same "images only" criterion as PQR seguimientos (evidence
 * photos, not documents), unlike task attachments which also allow PDF. */
export async function uploadOrderCommentAttachment(tenantId: string, file: File, commentId: string): Promise<CrmAttachment> {
  const validationError = validatePqrAttachmentFile(file)
  if (validationError) throw new Error(validationError)
  const uploaded = await uploadAttachmentFile(tenantId, file)

  const {
    data: { user },
  } = await supabase.auth.getUser()

  const { data, error } = await supabase
    .from('crm_attachments')
    .insert({
      tenant_id: tenantId,
      order_comment_id: commentId,
      storage_path: uploaded.storage_path,
      mime_type: uploaded.mime_type,
      size_bytes: uploaded.size_bytes,
      original_filename: file.name || null,
      created_by: user?.id ?? null,
    })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function listAttachmentsForOrderComments(commentIds: string[]): Promise<CrmAttachment[]> {
  if (commentIds.length === 0) return []
  const { data, error } = await supabase
    .from('crm_attachments')
    .select('*')
    .in('order_comment_id', commentIds)
    .order('created_at', { ascending: true })
  if (error) throw error
  return data
}

export async function listAttachmentsForPqr(pqrId: string): Promise<CrmAttachment[]> {
  const { data, error } = await supabase.from('crm_attachments').select('*').eq('pqr_id', pqrId).order('created_at', { ascending: true })
  if (error) throw error
  return data
}

export async function listAttachmentsForPqrUpdates(pqrUpdateIds: string[]): Promise<CrmAttachment[]> {
  if (pqrUpdateIds.length === 0) return []
  const { data, error } = await supabase
    .from('crm_attachments')
    .select('*')
    .in('pqr_update_id', pqrUpdateIds)
    .order('created_at', { ascending: true })
  if (error) throw error
  return data
}

export async function listAttachmentsForTask(taskId: string): Promise<CrmAttachment[]> {
  const { data, error } = await supabase.from('crm_attachments').select('*').eq('task_id', taskId).order('created_at', { ascending: true })
  if (error) throw error
  return data
}

/** Bucket is private (unlike tenant-logos) -- attachments are shown via a
 * short-lived signed URL rather than a public one. */
export async function getAttachmentSignedUrl(storagePath: string): Promise<string> {
  const { data, error } = await supabase.storage.from('crm-attachments').createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS)
  if (error) throw error
  return data.signedUrl
}
