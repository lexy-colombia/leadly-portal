export type UserRole = 'superadmin' | 'tenant_admin' | 'tenant_agent'
export type TenantStatus = 'active' | 'inactive'
export type TenantEntityType = 'persona' | 'empresa'
export type TenantDocumentType = 'NIT' | 'CC' | 'CE' | 'RUC' | 'RFC' | 'PASAPORTE' | 'OTRO'
export type TenantLanguage = 'es' | 'en'
export type WhatsappLineStatus = 'pending_verification' | 'active' | 'suspended'
export type AiProvider = 'openai' | 'gemini'
export type ConversationMode = 'ia' | 'humano'
export type ConversationStatus = 'open' | 'closed'
export type ConversationCategory = 'venta' | 'soporte' | 'consulta' | 'reclamo' | 'otro'
export type MessageDirection = 'inbound' | 'outbound'
export type MessageSenderType = 'contact' | 'ia' | 'agent'

export interface Tenant {
  id: string
  name: string
  status: TenantStatus
  contact_email: string | null
  contact_phone: string | null
  notes: string | null
  entity_type: TenantEntityType
  legal_name: string | null
  document_type: TenantDocumentType | null
  document_number: string | null
  country: string | null
  state_province: string | null
  preferred_language: TenantLanguage
  logo_url: string | null
  created_at: string
  updated_at: string
}

export interface Profile {
  id: string
  tenant_id: string | null
  full_name: string
  email: string
  phone: string | null
  role: UserRole
  active: boolean
  last_login_at: string | null
  created_at: string
  updated_at: string
}

export interface AiModel {
  provider: AiProvider
  model_code: string
  display_name: string
  is_active: boolean
  display_order: number
}

export interface WhatsappLine {
  id: string
  tenant_id: string
  phone_number_id: string
  business_account_id: string
  display_name: string
  status: WhatsappLineStatus
  created_at: string
  updated_at: string
}

export interface AiAssistant {
  id: string
  whatsapp_line_id: string
  provider: AiProvider
  model: string
  system_prompt: string
  temperature: number
  max_tokens: number
  is_active: boolean
  updated_by: string | null
  created_at: string
  updated_at: string
}

export interface WhatsappConversation {
  id: string
  tenant_id: string
  whatsapp_line_id: string
  contact_phone: string
  contact_name: string | null
  contact_id: string | null
  mode: ConversationMode
  status: ConversationStatus
  category: ConversationCategory | null
  assigned_agent_id: string | null
  last_message_at: string | null
  created_at: string
  updated_at: string
}

export type ContactStage = 'lead' | 'contactado' | 'negociacion' | 'cliente' | 'perdido'

export interface CrmContact {
  id: string
  tenant_id: string
  full_name: string
  phone: string
  email: string | null
  company: string | null
  stage: ContactStage
  tags: string[]
  assigned_to: string | null
  created_at: string
  updated_at: string
}

export interface CrmNote {
  id: string
  tenant_id: string
  contact_id: string
  author_id: string | null
  content: string
  created_at: string
}

export type AppointmentStatus = 'activa' | 'completada' | 'cancelada'

export interface CrmAppointment {
  id: string
  tenant_id: string
  contact_id: string
  whatsapp_line_id: string | null
  scheduled_at: string
  notes: string | null
  status: AppointmentStatus
  created_by: string | null
  reminder_sent_at: string | null
  created_at: string
  updated_at: string
}

export interface WhatsappMessage {
  id: string
  conversation_id: string
  direction: MessageDirection
  sender_type: MessageSenderType
  sender_profile_id: string | null
  content: string
  wamid: string | null
  tokens_used: number | null
  error_message: string | null
  created_at: string
}
