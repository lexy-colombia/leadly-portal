import { supabase } from '../supabaseClient'
import type { WhatsappMessageTemplate, WhatsappTemplateCategory } from '../../types/domain'

export interface CreateTemplateInput {
  tenant_id: string
  name: string
  category: WhatsappTemplateCategory
  language: string
  body_text: string
  /** Texto de muestra por cada {{n}} del cuerpo -- Meta rechaza automático
   * cualquier plantilla con variables si no viene una muestra por cada una
   * ("Variables de plantilla sin texto de muestra"). Solo se usan para la
   * revisión, nunca se envían a los clientes. */
  body_variable_samples: string[]
}

/** Cuenta las variables posicionales {{n}} de un cuerpo de plantilla --
 * mismo criterio que countVariables en whatsapp-manage-templates, usado acá
 * solo para saber cuántos inputs de muestra mostrar mientras se escribe. */
export function countTemplateVariables(bodyText: string): number {
  const matches = [...bodyText.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]))
  return matches.length === 0 ? 0 : Math.max(...matches)
}

export interface SendTemplateMessageInput {
  tenant_id: string
  whatsapp_line_id: string
  contact_id?: string | null
  contact_phone: string
  contact_name?: string | null
  template_id: string
  variables: string[]
}

/** Desempaqueta el `{ error }` que devuelven las Edge Functions de esta app
 * -- mismo patrón que connectWhatsappLineViaEmbeddedSignup en
 * whatsappLines.ts y sendHumanMessage en conversations.ts. */
async function unwrapFunctionError(error: unknown): Promise<never> {
  const context = (error as { context?: Response }).context
  if (context && typeof context.json === 'function') {
    let specificMessage: string | undefined
    try {
      const body = await context.json()
      specificMessage = body?.error
    } catch {
      /* fall through to generic error */
    }
    if (specificMessage) throw new Error(specificMessage)
  }
  throw error
}

export async function listMessageTemplates(tenantId: string): Promise<WhatsappMessageTemplate[]> {
  const { data, error } = await supabase
    .from('whatsapp_message_templates')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
  if (error) throw error
  return data
}

export async function listApprovedTemplates(tenantId: string): Promise<WhatsappMessageTemplate[]> {
  const { data, error } = await supabase
    .from('whatsapp_message_templates')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('status', 'APPROVED')
    .order('name', { ascending: true })
  if (error) throw error
  return data
}

export async function createMessageTemplate(input: CreateTemplateInput): Promise<WhatsappMessageTemplate> {
  const { data, error } = await supabase.functions.invoke('whatsapp-manage-templates', {
    body: { action: 'create', ...input },
  })
  if (error) return unwrapFunctionError(error)
  if (data?.error) throw new Error(data.error)
  return data.template
}

export interface EditTemplateInput {
  tenant_id: string
  template_id: string
  body_text: string
  body_variable_samples: string[]
}

/** Solo el cuerpo (y sus muestras) se puede editar -- nombre/idioma son la
 * identidad de la plantilla en el WABA de Meta, no se pueden cambiar. Editar
 * vuelve a mandar la plantilla a revisión (Meta la pone en PENDING de
 * nuevo), típico para corregir una que Meta rechazó. */
export async function editMessageTemplate(input: EditTemplateInput): Promise<WhatsappMessageTemplate> {
  const { data, error } = await supabase.functions.invoke('whatsapp-manage-templates', {
    body: { action: 'edit', ...input },
  })
  if (error) return unwrapFunctionError(error)
  if (data?.error) throw new Error(data.error)
  return data.template
}

export async function syncTemplateStatuses(tenantId: string): Promise<number> {
  const { data, error } = await supabase.functions.invoke('whatsapp-manage-templates', {
    body: { action: 'sync_status', tenant_id: tenantId },
  })
  if (error) return unwrapFunctionError(error)
  if (data?.error) throw new Error(data.error)
  return data.synced ?? 0
}

export async function deleteMessageTemplate(templateId: string): Promise<void> {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const { error } = await supabase
    .from('whatsapp_message_templates')
    .update({ deleted_at: new Date().toISOString(), deleted_by: user?.id ?? null })
    .eq('id', templateId)
  if (error) throw error
}

export async function sendTemplateMessage(input: SendTemplateMessageInput): Promise<{ conversationId: string }> {
  const { data, error } = await supabase.functions.invoke('whatsapp-send-template', {
    body: input,
  })
  if (error) return unwrapFunctionError(error)
  if (data?.error) throw new Error(data.error)
  return { conversationId: data.conversation.id }
}
