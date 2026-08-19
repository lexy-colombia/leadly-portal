export type UserRole = 'superadmin' | 'tenant_admin' | 'tenant_agent'
export type TenantStatus = 'active' | 'inactive'
export type TenantEntityType = 'persona' | 'empresa'
export type TenantDocumentType = 'NIT' | 'CC' | 'CE' | 'RUC' | 'RFC' | 'PASAPORTE' | 'OTRO'
export type TenantLanguage = 'es' | 'en'
export type WhatsappLineStatus = 'pending_verification' | 'active' | 'suspended' | 'disconnected'
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
  billing_address: string | null
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
  display_phone_number: string | null
  status: WhatsappLineStatus
  /** Currently assigned agent, if any -- a line can have zero or one active
   * agent, and the same agent can be assigned to several lines (see
   * AiAssistant, decoupled from lines 2026-08-06). */
  ai_assistant_id: string | null
  created_at: string
  updated_at: string
}

/** A reusable AI agent persona, scoped to a tenant -- not to a single
 * WhatsApp line. Assignable to zero or more `whatsapp_lines` via
 * `WhatsappLine.ai_assistant_id`. */
export interface AiAssistant {
  id: string
  tenant_id: string
  name: string
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

export interface AiSkill {
  id: string
  key: string
  name: string
  description: string
  prompt_fragment: string
  is_active: boolean
  created_at: string
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
  context_reset_at: string | null
  archived_at: string | null
  last_message_at: string | null
  /** Solo se actualiza con mensajes entrantes -- a diferencia de
   * last_message_at, sirve para saber si la ventana de 24h de WhatsApp sigue
   * abierta (un agente puede mandar varios salientes sin que el contacto
   * responda, y last_message_at seguiría viéndose "reciente"). */
  last_inbound_message_at: string | null
  /** Mensajes entrantes sin leer mientras la conversación está en modo
   * humano -- mantenido por trigger (bump_conversation_unread_count), ver
   * migración 20260819010001. Solo tiene sentido mostrarlo en modo humano
   * (en modo ia la IA ya está respondiendo); se resetea a 0 al abrir la
   * conversación (markConversationRead) o al devolverla a la IA. */
  unread_count: number
  /** Si esta conversación arrancó de una campaña masiva (o le mandaron una
   * campaña más reciente), apunta a esa Campaign -- whatsapp-ai-respond lo
   * usa para que la IA siga el "tema" de la campaña una vez que el contacto
   * responde. */
  campaign_id: string | null
  created_at: string
  updated_at: string
}

export type CampaignStatus = 'draft' | 'scheduled' | 'sending' | 'completed' | 'canceled' | 'failed'

/** Envío masivo programado de una plantilla a una lista de contactos subida
 * por CSV -- Fase 2 de "iniciar conversaciones" (ver CLAUDE.md). */
export interface Campaign {
  id: string
  tenant_id: string
  name: string
  whatsapp_line_id: string
  template_id: string
  topic: string | null
  scheduled_at: string
  status: CampaignStatus
  total_recipients: number
  sent_count: number
  failed_count: number
  created_by: string | null
  created_at: string
  updated_at: string
}

export type CampaignRecipientStatus = 'pending' | 'sent' | 'failed'

export interface CampaignRecipient {
  id: string
  tenant_id: string
  campaign_id: string
  contact_phone: string
  contact_name: string | null
  variables: string[]
  status: CampaignRecipientStatus
  error_message: string | null
  whatsapp_message_id: string | null
  sent_at: string | null
  created_at: string
}

export type WhatsappTemplateCategory = 'MARKETING' | 'UTILITY' | 'AUTHENTICATION'
export type WhatsappTemplateStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'PAUSED' | 'DISABLED'
export type WhatsappTemplateButtonType = 'QUICK_REPLY' | 'URL' | 'PHONE_NUMBER'

/** Botón estático de una plantilla -- hasta 3 por plantilla (máx. 2 de tipo
 * URL, máx. 1 de tipo PHONE_NUMBER), validado en profundidad en
 * whatsapp-manage-templates. Sin URL dinámica con {{1}} todavía. */
export interface WhatsappTemplateButton {
  type: WhatsappTemplateButtonType
  text: string
  url?: string
  phone_number?: string
}

/** Plantilla de WhatsApp (HSM) propia del tenant -- ver CLAUDE.md, Fase 1 de
 * "iniciar conversaciones". Cuerpo con variables posicionales {{n}},
 * encabezado de imagen opcional, hasta 3 botones estáticos. */
export interface WhatsappMessageTemplate {
  id: string
  tenant_id: string
  business_account_id: string
  meta_template_id: string | null
  name: string
  category: WhatsappTemplateCategory
  language: string
  status: WhatsappTemplateStatus
  body_text: string
  variable_count: number
  header_image_path: string | null
  buttons: WhatsappTemplateButton[]
  rejected_reason: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface ConversationTag {
  id: string
  tenant_id: string
  name: string
  deleted_at: string | null
  deleted_by: string | null
  created_at: string
}

export type ClientStage = 'lead' | 'contactado' | 'negociacion' | 'cliente' | 'perdido'

export interface Client {
  id: string
  tenant_id: string
  full_name: string
  phone: string
  email: string | null
  company: string | null
  nit: string | null
  industry: string | null
  website: string | null
  address: string | null
  city: string | null
  notes: string | null
  is_active: boolean
  stage: ClientStage
  tags: string[]
  assigned_to: string | null
  hubspot_contact_id: string | null
  deleted_at: string | null
  deleted_by: string | null
  created_at: string
  updated_at: string
}

export interface Pipeline {
  id: string
  tenant_id: string
  name: string
  description: string | null
  color: string
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface PipelineStage {
  id: string
  pipeline_id: string
  name: string
  display_order: number
  color: string
  probability: number
  is_won: boolean
  is_lost: boolean
  created_at: string
}

export type OpportunityPriority = 'baja' | 'media' | 'alta'
export type OpportunityStatus = 'open' | 'won' | 'lost'

export interface Opportunity {
  id: string
  tenant_id: string
  pipeline_id: string
  stage_id: string
  contact_id: string
  owner_id: string | null
  title: string
  value: number
  currency: string
  priority: OpportunityPriority
  source: string | null
  expected_close_date: string | null
  status: OpportunityStatus
  description: string | null
  deleted_at: string | null
  deleted_by: string | null
  created_at: string
  updated_at: string
}

export type TaskPriority = 'baja' | 'media' | 'alta'
export type TaskStatus = 'pendiente' | 'en_proceso' | 'completada' | 'cancelada'

export interface Task {
  id: string
  tenant_id: string
  contact_id: string | null
  opportunity_id: string | null
  assigned_to: string | null
  title: string
  description: string | null
  priority: TaskPriority
  status: TaskStatus
  due_date: string
  deleted_at: string | null
  deleted_by: string | null
  created_at: string
  updated_at: string
}

// Catálogo -- esquema ERP sin prefijo (products/product_images/
// product_categories/suppliers/brands). Cutover empezado el 2026-08-16
// (pedido explícito del usuario): el frontend ya lee/escribe estas tablas
// en vez de crm_products/crm_product_images/crm_product_categories/
// crm_suppliers. Esas tablas viejas siguen existiendo intactas (no se
// borran), pero el catálogo humano y el picker de productos de una orden
// ya no las usan. Sin stock_quantity/reserved_stock -- ese contador plano
// no existe en `products`, a propósito (ver core_catalog.sql): el stock
// vive solo en product_stock/stock_movements (Inventario Fase 1), que ya
// se repuntaron a esta tabla en la misma migración de este cutover.
export interface Product {
  id: string
  tenant_id: string
  name: string
  description: string | null
  sku: string | null
  slug: string | null
  supplier_id: string | null
  brand_id: string | null
  purchase_price: number | null
  wholesale_price: number | null
  retail_price: number | null
  currency: string
  track_inventory: boolean
  low_stock_threshold: number
  is_active: boolean
  deleted_at: string | null
  deleted_by: string | null
  created_at: string
  updated_at: string
}

export interface ProductImage {
  id: string
  tenant_id: string
  product_id: string
  storage_path: string
  display_order: number
  created_at: string
}

export interface ProductCategory {
  id: string
  tenant_id: string
  name: string
  description: string | null
  parent_category_id: string | null
  is_active: boolean
  deleted_at: string | null
  deleted_by: string | null
  created_at: string
  updated_at: string
}

export interface Brand {
  id: string
  tenant_id: string
  name: string
  description: string | null
  logo_url: string | null
  is_active: boolean
  deleted_at: string | null
  deleted_by: string | null
  created_at: string
  updated_at: string
}

export interface Supplier {
  id: string
  tenant_id: string
  name: string
  contact_name: string | null
  phone: string | null
  email: string | null
  notes: string | null
  is_active: boolean
  deleted_at: string | null
  deleted_by: string | null
  created_at: string
  updated_at: string
}

export type OrderStatus = 'cotizacion' | 'confirmada' | 'en_proceso' | 'entregada' | 'cancelada'

export interface SalesOrder {
  id: string
  tenant_id: string
  number: number
  contact_id: string
  opportunity_id: string | null
  status: OrderStatus
  currency: string
  subtotal: number
  discount_total: number
  tax_total: number
  shipping: number
  total: number
  notes: string | null
  valid_until: string | null
  shipping_address_id: string | null
  billing_address_id: string | null
  created_by: string | null
  deleted_at: string | null
  deleted_by: string | null
  created_at: string
  updated_at: string
}

export interface ContactAddress {
  id: string
  tenant_id: string
  contact_id: string
  label: string | null
  is_shipping: boolean
  is_billing: boolean
  recipient_name: string | null
  phone: string | null
  tax_id: string | null
  line1: string
  line2: string | null
  city: string | null
  state_province: string | null
  postal_code: string | null
  country: string | null
  notes: string | null
  is_default: boolean
  deleted_at: string | null
  deleted_by: string | null
  created_at: string
  updated_at: string
}

export interface SalesOrderItem {
  id: string
  tenant_id: string
  order_id: string
  product_id: string | null
  warehouse_id: string | null
  product_name: string
  sku: string | null
  quantity: number
  unit_price: number
  discount_percentage: number
  subtotal: number
  display_order: number
  created_at: string
}

export type OrderPaymentMethod = 'efectivo' | 'transferencia' | 'tarjeta' | 'otro'

export interface SalesOrderPayment {
  id: string
  tenant_id: string
  order_id: string
  method: OrderPaymentMethod
  amount: number
  currency: string
  paid_at: string
  notes: string | null
  created_by: string | null
  deleted_at: string | null
  deleted_by: string | null
  created_at: string
  updated_at: string
}

export interface SalesOrderComment {
  id: string
  tenant_id: string
  order_id: string
  author_id: string | null
  content: string
  created_by_ai: boolean
  created_at: string
}

export interface Note {
  id: string
  tenant_id: string
  contact_id: string
  author_id: string | null
  content: string
  created_by_ai: boolean
  created_at: string
}

export type AppointmentStatus = 'activa' | 'completada' | 'cancelada'

export interface Appointment {
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

/** Appointment + the contact's display name, for tenant-wide views (the
 * calendar) that aren't already scoped to one contact. */
export interface AppointmentWithContact extends Appointment {
  contact_full_name: string | null
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
  media_storage_path: string | null
  media_mime_type: string | null
  media_size_bytes: number | null
  created_at: string
}

/** `attachments` -- shared by task attachments (task_id) and sales order
 * comment attachments (sales_order_comment_id), mutually exclusive per row. */
export interface Attachment {
  id: string
  tenant_id: string
  task_id: string | null
  sales_order_comment_id: string | null
  storage_path: string
  mime_type: string
  size_bytes: number
  original_filename: string | null
  created_by: string | null
  created_by_ai: boolean
  created_at: string
}

export type PaymentCredentialMode = 'sandbox' | 'production'

export interface PaymentProvider {
  key: string
  name: string
  is_active: boolean
  created_at: string
  updated_at: string
}

/** tenant_id null = a platform-level credential (Leadly billing its
 * tenants, today's only real consumer). Non-null = that tenant's own
 * credential, for when a tenant bills its own end customers -- schema-ready,
 * not consumed by any screen yet. */
export interface TenantPaymentCredential {
  id: string
  tenant_id: string | null
  provider_key: string
  mode: PaymentCredentialMode
  config: Record<string, unknown>
  is_active: boolean
  created_at: string
  updated_at: string
}

export type BillingInterval = 'monthly' | 'yearly'

export interface BillingPlan {
  id: string
  key: string
  name: string
  description: string | null
  amount_cents: number
  currency: string
  billing_interval: BillingInterval
  is_active: boolean
  /** Max active users a tenant on this plan may have. NULL = unlimited.
   * Enforced by a DB trigger on profiles, see
   * 20260811000006_billing_plans_max_users.sql -- this isn't just a display
   * value, inviting/reactivating past it fails server-side regardless of
   * which path (Edge Function or direct RLS update) is used. */
  max_users: number | null
  /** Max active WhatsApp lines a tenant on this plan may have connected.
   * NULL = unlimited. Enforced by a DB trigger on whatsapp_lines, see
   * 20260811000007_billing_plans_max_whatsapp_lines.sql. */
  max_whatsapp_lines: number | null
  created_at: string
  updated_at: string
}

export type BillingSubscriptionStatus = 'ACTIVE' | 'CANCELLED' | 'PAST_DUE' | 'EXPIRED' | 'PENDING_PAYMENT'

export interface BillingSubscription {
  id: string
  tenant_id: string
  plan_id: string
  status: BillingSubscriptionStatus
  current_period_start: string | null
  current_period_end: string | null
  /** Set by cancel_subscription() when the subscription still has a paid,
   * in-progress period -- stays ACTIVE (usable) until current_period_end,
   * then the cron flips it to CANCELLED instead of billing a renewal. */
  cancel_at_period_end: boolean
  created_at: string
  updated_at: string
  cancelled_at: string | null
}

export type PaymentInvoiceStatus = 'PENDING' | 'PAID' | 'OVERDUE' | 'CANCELLED' | 'REFUNDED'

export interface PaymentInvoice {
  id: string
  merchant_tenant_id: string | null
  payer_tenant_id: string | null
  subscription_id: string | null
  provider_key: string
  amount_cents: number
  currency: string
  status: PaymentInvoiceStatus
  invoice_number: string | null
  description: string | null
  due_date: string | null
  provider_checkout_id: string | null
  provider_transaction_id: string | null
  provider_payment_method: string | null
  provider_payment_data: Record<string, unknown> | null
  // Snapshot of the buyer (tenant) at the moment the invoice was issued, plus
  // the tax breakdown -- the data a Colombian electronic invoice (DIAN)
  // requires. Filled server-side by a trigger, see
  // 20260811000004_payment_invoices_dian_fields.sql.
  buyer_legal_name: string | null
  buyer_document_type: string | null
  buyer_document_number: string | null
  buyer_email: string | null
  buyer_address: string | null
  buyer_country: string | null
  buyer_state_province: string | null
  subtotal_cents: number | null
  tax_cents: number | null
  tax_rate: number
  deleted_at: string | null
  deleted_by: string | null
  created_at: string
  updated_at: string
}

export interface PaymentAttempt {
  id: string
  invoice_id: string
  provider_key: string
  provider_transaction_id: string | null
  status: string
  amount_cents: number | null
  currency: string | null
  payment_method: string | null
  payment_brand: string | null
  payment_last_four: string | null
  payment_bank: string | null
  payment_reference: string | null
  raw_data: Record<string, unknown> | null
  created_at: string
}

export interface PaymentInvoiceItem {
  id: string
  invoice_id: string
  description: string
  quantity: number
  unit_price_cents: number
  subtotal_cents: number
  display_order: number
  created_at: string
}

// Embedded-relation shape for the backoffice's platform-wide Facturas tab
// (all tenants at once) -- same pattern as OpportunityWithRelations in
// lib/api/opportunities.ts.
export type PaymentInvoiceWithTenant = PaymentInvoice & {
  tenant: { name: string } | null
}

export type IntegrationCategory = 'invoicing' | 'accounting' | 'messaging' | 'payments' | 'crm' | 'ecommerce' | 'other'

export interface IntegrationProvider {
  key: string
  name: string
  category: IntegrationCategory
  description: string | null
  is_active: boolean
  created_at: string
  updated_at: string
}

/** tenant_id null = a platform-level credential (Leadly's own account with
 * this provider); tenant_id set = that tenant's own account -- same scoping
 * as tenant_payment_credentials. */
export interface IntegrationCredential {
  id: string
  tenant_id: string | null
  provider_key: string
  mode: 'sandbox' | 'production'
  config: Record<string, unknown>
  is_active: boolean
  created_at: string
  updated_at: string
  deleted_at: string | null
  deleted_by: string | null
}

// --- ERP: Fase 1 (Inventario) -- ver CLAUDE.md "Estado actual (2026-08-15)
// -- Pivote a ERP". product_stock/stock_movements referenciaban
// crm_products originalmente; se repuntaron a `products` el 2026-08-16
// como parte del cutover del catálogo (ver Product más arriba).

export type WarehouseType = 'bodega' | 'punto_venta' | 'transito'

export interface Warehouse {
  id: string
  tenant_id: string
  name: string
  address: string | null
  city: string | null
  type: WarehouseType
  manager_name: string | null
  phone: string | null
  is_default: boolean
  is_active: boolean
  created_at: string
  updated_at: string
  deleted_at: string | null
  deleted_by: string | null
}

export interface ProductStock {
  id: string
  tenant_id: string
  product_id: string
  warehouse_id: string
  quantity: number
  reserved_quantity: number
  departure_quantity: number
  damaged_quantity: number
  created_at: string
  updated_at: string
}

export type StockMovementType =
  | 'entrada'
  | 'salida'
  | 'ajuste_positivo'
  | 'ajuste_negativo'
  | 'transferencia_salida'
  | 'transferencia_entrada'
  | 'reserva'
  | 'liberacion_reserva'
  | 'salida_despacho'
  | 'entrega_despacho'
  | 'ajuste_dano'
  | 'reversion_dano'
export type StockReferenceType = 'carga_inicial' | 'compra' | 'despacho' | 'ajuste_manual' | 'transferencia'

export interface StockMovement {
  id: string
  tenant_id: string
  product_id: string
  warehouse_id: string
  movement_type: StockMovementType
  quantity: number
  unit_cost: number | null
  reference_type: StockReferenceType | null
  reference_id: string | null
  notes: string | null
  created_by: string | null
  created_at: string
}
