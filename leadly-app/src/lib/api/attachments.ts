import { supabase } from '../supabaseClient'
import type { Attachment } from '../../types/domain'
import { PQR_ATTACHMENT_ALLOWED_TYPES, PQR_ATTACHMENT_MAX_BYTES, TASK_ATTACHMENT_ALLOWED_TYPES, TASK_ATTACHMENT_MAX_BYTES } from '../referenceData'

const SIGNED_URL_TTL_SECONDS = 60 * 60

// Returns a translation key (under common.attachment.error.*) instead of a literal
// message, since this is plain business logic with no access to the language
// context -- call sites resolve it with `t()`.
export type AttachmentValidationError = 'common.attachment.error.invalidImageType' | 'common.attachment.error.invalidFileType' | 'common.attachment.error.tooLarge'

export function validatePqrAttachmentFile(file: File): AttachmentValidationError | null {
  if (!PQR_ATTACHMENT_ALLOWED_TYPES.includes(file.type)) return 'common.attachment.error.invalidImageType'
  if (file.size > PQR_ATTACHMENT_MAX_BYTES) return 'common.attachment.error.tooLarge'
  return null
}

export function validateTaskAttachmentFile(file: File): AttachmentValidationError | null {
  if (!TASK_ATTACHMENT_ALLOWED_TYPES.includes(file.type)) return 'common.attachment.error.invalidFileType'
  if (file.size > TASK_ATTACHMENT_MAX_BYTES) return 'common.attachment.error.tooLarge'
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

/** Uploads an image the agent is about to send directly in the human-mode
 * chat -- whatsapp-send-human just reads it back by storage_path to build
 * the outbound WhatsApp message. */
export async function uploadChatImage(tenantId: string, file: File): Promise<UploadedMedia> {
  const validationError = validatePqrAttachmentFile(file)
  if (validationError) throw new Error(validationError)
  return uploadAttachmentFile(tenantId, file)
}

/** Uploads a file (image or PDF -- a task attachment is very likely a
 * proposal/quote sent to a client) and links it to a task. Only meaningful
 * for an existing task: attachments.task_id needs a real row to point
 * at, so TaskDrawer only offers this once the task has already been saved. */
export async function uploadTaskAttachment(tenantId: string, file: File, taskId: string): Promise<Attachment> {
  const validationError = validateTaskAttachmentFile(file)
  if (validationError) throw new Error(validationError)
  const uploaded = await uploadAttachmentFile(tenantId, file)

  const {
    data: { user },
  } = await supabase.auth.getUser()

  const { data, error } = await supabase
    .from('attachments')
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
 * comment -- same "images only" criterion as before, unlike task
 * attachments which also allow PDF. Both this and uploadTaskAttachment
 * share the same `attachments` table now (task_id/sales_order_comment_id
 * are mutually exclusive columns on the same row shape). */
export async function uploadOrderCommentAttachment(tenantId: string, file: File, commentId: string): Promise<Attachment> {
  const validationError = validatePqrAttachmentFile(file)
  if (validationError) throw new Error(validationError)
  const uploaded = await uploadAttachmentFile(tenantId, file)

  const {
    data: { user },
  } = await supabase.auth.getUser()

  const { data, error } = await supabase
    .from('attachments')
    .insert({
      tenant_id: tenantId,
      sales_order_comment_id: commentId,
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

export async function listAttachmentsForOrderComments(commentIds: string[]): Promise<Attachment[]> {
  if (commentIds.length === 0) return []
  const { data, error } = await supabase
    .from('attachments')
    .select('*')
    .in('sales_order_comment_id', commentIds)
    .order('created_at', { ascending: true })
  if (error) throw error
  return data
}

export async function listAttachmentsForTask(taskId: string): Promise<Attachment[]> {
  const { data, error } = await supabase.from('attachments').select('*').eq('task_id', taskId).order('created_at', { ascending: true })
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
