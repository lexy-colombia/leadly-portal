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
  storefront_slug: string | null
  storefront_enabled: boolean
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
  /** Solo aplica a role='tenant_agent' -- qué tenant_role tiene asignado.
   * tenant_admin/superadmin lo ignoran (siempre tienen acceso total). */
  tenant_role_id: string | null
  active: boolean
  last_login_at: string | null
  created_at: string
  updated_at: string
}

/** Catálogo fijo de acciones posibles (ver permission_actions) -- de código,
 * nadie lo edita desde la UI. */
export interface PermissionAction {
  key: string
  module_key: string
  name: string
  description: string | null
  display_order: number
}

/** Un rol que un tenant creó para sus agentes (ver tenant_roles) -- el
 * tenant se autogestiona esto, a diferencia de tenant_enabled_modules. */
export interface TenantRole {
  id: string
  tenant_id: string
  name: string
  description: string | null
  created_by: string | null
  deleted_at: string | null
  deleted_by: string | null
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

export interface Client {
  id: string
  tenant_id: string
  full_name: string
  /** Indicativo de país (ej. "57") -- separado de `phone` desde
   * 20260904000000_clients_phone_prefix_split.sql. `phone` es SOLO el
   * número local; usar combinePhone(phone_prefix, phone) (lib/phone.ts)
   * para reconstruir el número completo cuando haga falta. */
  phone_prefix: string
  phone: string
  email: string | null
  company: string | null
  nit: string | null
  document_type: TenantDocumentType | null
  document_number: string | null
  dian_document_type_code: string | null
  applies_withholding: boolean
  country: string | null
  notes: string | null
  is_active: boolean
  tags: string[]
  assigned_to: string | null
  hubspot_contact_id: string | null
  credit_enabled: boolean
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
  completed_at: string | null
  completed_by: string | null
  reminder_sent_at: string | null
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
  has_variants: boolean
  tax_type_code: string | null
  tax_rate: number
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
  variant_id: string | null
  created_at: string
}

// Variantes de producto (talla/color/etc.) -- ver CLAUDE.md "Estado actual"
// para el diseño completo. product_options declara hasta 3 ejes por
// producto (name + values, en el orden que se cargaron); product_variants
// son las combinaciones vendibles reales, cada una con su propio SKU y
// stock (product_stock/stock_movements.variant_id). Precios nullable en la
// variante heredan del producto padre cuando no se definen -- eso se
// resuelve en la capa de aplicación (lib/api/products.ts), no acá.
export interface ProductOption {
  id: string
  tenant_id: string
  product_id: string
  name: string
  display_order: number
  values: string[]
  created_at: string
  updated_at: string
}

export interface ProductVariant {
  id: string
  tenant_id: string
  product_id: string
  sku: string | null
  option1_value: string | null
  option2_value: string | null
  option3_value: string | null
  purchase_price: number | null
  wholesale_price: number | null
  retail_price: number | null
  is_active: boolean
  deleted_at: string | null
  deleted_by: string | null
  created_at: string
  updated_at: string
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

// Estado comercial de la orden (cotización/venta/anulada) -- separado del
// estado de entrega (ver DeliveryStatus) desde el 2026-08-20, pedido
// explícito del usuario: "una cosa es el estado de la orden y otra cosa el
// estado de envío". Antes 'en_proceso'/'entregada' vivían acá y en realidad
// describían el envío, no el negocio de la venta en sí.
export type OrderStatus = 'cotizacion' | 'confirmada' | 'cancelada'

// Genérico a propósito -- se mantiene solo como el estado "resumen" de 3
// valores que usa el badge/filtro de la lista de Órdenes. Ya no se deriva
// automáticamente de nada (el mapeo por DispatchStatus.stock_effect se sacó
// el 2026-08-25, decisión del usuario: un despacho es puro seguimiento
// logístico) -- se actualiza a mano vía updateDeliveryStatus
// (lib/api/orders.ts). La orden en sí muestra el nombre real del estado de
// despacho (ver Dispatch/DispatchStatus más abajo), no este bucket
// traducido.
export type DeliveryStatus = 'pendiente' | 'en_camino' | 'entregado'

export interface SalesOrder {
  id: string
  tenant_id: string
  number: number
  contact_id: string
  opportunity_id: string | null
  status: OrderStatus
  delivery_status: DeliveryStatus
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
  variant_id: string | null
  product_name: string
  sku: string | null
  quantity: number
  unit_price: number
  discount_amount: number
  subtotal: number
  display_order: number
  tax_type_code: string | null
  tax_rate: number
  tax_amount: number
  taxable_base: number
  created_at: string
}

export type OrderPaymentMethod = 'efectivo' | 'transferencia' | 'tarjeta' | 'credito' | 'saldo_favor' | 'wompi'

/** Subset of OrderPaymentMethod valid for paying down a credit balance
 * (credit_payments.method) -- 'credito' is deliberately excluded (paying
 * credit debt with more credit doesn't make sense), same for
 * 'saldo_favor' (that's the opposite ledger entirely, ver
 * store_credit_grants -- "el cliente me debe" vs "yo le debo al cliente").
 * 'wompi' excluded too for now -- this round only wired it into sales order
 * collection, not the separate credit-repayment flow. */
export type CreditPaymentMethod = Exclude<OrderPaymentMethod, 'credito' | 'saldo_favor' | 'wompi'>

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
  /** Only set when method === 'wompi' (payment recorded automatically by
   * payment-webhook-wompi, see leadly-db) -- null for every manually-typed
   * payment. */
  provider_key: string | null
  provider_transaction_id: string | null
  /** Human-readable detail of the Wompi transaction, e.g. "PSE - Bancolombia"
   * or "VISA ****1234" -- shown instead of the generic "Wompi" label. */
  provider_reference: string | null
  payment_link_id: string | null
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
  // true -> shows in the order page's "Notas" column (internal, no
  // attachments); false -> "Comentarios" (customer-facing, ver CLAUDE.md).
  is_internal: boolean
  created_at: string
}

/** Cargo a la cuenta de crédito de un cliente -- append-only, nace
 * automáticamente cuando se registra un SalesOrderPayment con
 * method='credito' (ver trigger apply_credit_payment_charge). */
export interface CreditCharge {
  id: string
  tenant_id: string
  client_id: string
  sales_order_id: string
  sales_order_payment_id: string
  amount: number
  notes: string | null
  created_by: string | null
  created_at: string
}

/** Abono contra el saldo de crédito general de un cliente (no contra una
 * orden puntual) -- distinto de SalesOrderPayment. Cada uno tiene un
 * recibo (receipt_number) secuencial por tenant. */
export interface CreditPayment {
  id: string
  tenant_id: string
  client_id: string
  receipt_number: number
  method: CreditPaymentMethod
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

/** Per-tenant configurable dispatch status catalog (Configuración ->
 * Despachos) -- same spirit as PipelineStage, one flat ordered list per
 * tenant instead of several "pipelines". No stock/delivery-status effect
 * of its own anymore (removed 2026-08-25, decisión del usuario): un
 * despacho es puro seguimiento logístico (transportadora, guía) -- si
 * hace falta actualizar sales_orders.delivery_status a mano, ver
 * updateDeliveryStatus en lib/api/orders.ts. */
export interface DispatchStatus {
  id: string
  tenant_id: string
  name: string
  color: string
  display_order: number
  is_terminal: boolean
  created_at: string
  updated_at: string
}

export type DispatchCarrierType = 'propio' | 'tercero'

/** One dispatch per order (1:1, no partial shipments yet). carrier_key
 * comes from the fixed frontend catalog (lib/carriers.ts) when
 * carrier_type='tercero', not a tenant-managed table. */
export interface Dispatch {
  id: string
  tenant_id: string
  sales_order_id: string
  status_id: string
  warehouse_id: string
  carrier_type: DispatchCarrierType
  carrier_key: string | null
  carrier_name: string | null
  tracking_number: string | null
  tracking_url: string | null
  notes: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

/** Append-only -- one row per status change, feeds the courier-style
 * timeline in DispatchDrawer.tsx. */
export interface DispatchStatusHistoryEntry {
  id: string
  tenant_id: string
  dispatch_id: string
  from_status_id: string | null
  to_status_id: string
  changed_by: string | null
  created_at: string
}

/** Ciclo de vida del ticket de devolución, configurable por tenant (mismo
 * mecanismo que DispatchStatus). A diferencia de DispatchStatus, no lleva
 * un efecto de inventario a nivel de estado -- eso se dispara por ítem
 * (ver ReturnItem.condition), no por el estado general del ticket. */
export interface ReturnStatus {
  id: string
  tenant_id: string
  name: string
  color: string
  display_order: number
  is_terminal: boolean
  created_at: string
  updated_at: string
}

/** El nombre lo elige el tenant, pero el `effect` es uno de 4 fijos que sí
 * controla comportamiento real (ver apply_return_resolution_credit()). */
export type ReturnResolutionEffect = 'saldo_a_favor' | 'reembolso_efectivo' | 'cambio' | 'ninguno'

export interface ReturnResolutionType {
  id: string
  tenant_id: string
  name: string
  effect: ReturnResolutionEffect
  display_order: number
  is_active: boolean
  created_at: string
  updated_at: string
}

/** El motivo es una constante fija (RETURN_REASONS en lib/returnReasons.ts),
 * a propósito no configurable -- pedido explícito del usuario. */
export type ReturnReason = 'danado' | 'equivocado' | 'no_esperado' | 'no_le_gusto' | 'otro'

export interface Return {
  id: string
  tenant_id: string
  sales_order_id: string
  status_id: string
  resolution_type_id: string | null
  reason: ReturnReason
  resolution_amount: number | null
  credit_granted: boolean
  notes: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

export type ReturnItemCondition = 'pendiente' | 'bueno' | 'danado'

export interface ReturnItem {
  id: string
  tenant_id: string
  return_id: string
  sales_order_item_id: string
  quantity: number
  condition: ReturnItemCondition
  stock_applied: boolean
  created_at: string
}

export interface ReturnStatusHistoryEntry {
  id: string
  tenant_id: string
  return_id: string
  from_status_id: string | null
  to_status_id: string
  changed_by: string | null
  created_at: string
}

/** Saldo a favor del cliente por una devolución resuelta con
 * effect='saldo_a_favor' -- ledger separado de credit_charges/
 * credit_payments (Cartera), que modelan la dirección contraria ("el
 * cliente me debe"). Redimir este saldo en una compra nueva queda
 * pendiente -- por ahora solo se acumula y se muestra. */
export interface StoreCreditGrant {
  id: string
  tenant_id: string
  client_id: string
  return_id: string
  amount: number
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
  assigned_to: string | null
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
  variant_id: string | null
  quantity: number
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
  | 'ajuste_dano'
  | 'reversion_dano'
  | 'entrada_devolucion'
  | 'devolucion_danada'
export type StockReferenceType = 'carga_inicial' | 'compra' | 'despacho' | 'ajuste_manual' | 'transferencia' | 'devolucion' | 'venta'

export interface StockMovement {
  id: string
  tenant_id: string
  product_id: string
  warehouse_id: string
  variant_id: string | null
  movement_type: StockMovementType
  quantity: number
  unit_cost: number | null
  reference_type: StockReferenceType | null
  reference_id: string | null
  notes: string | null
  created_by: string | null
  created_at: string
}

// --- Facturación electrónica DIAN (Fase 1 -- cimientos). Cada tenant es su
// propio facturador electrónico, no Leadly (ver CLAUDE.md). Ver migraciones
// 20260903100000..20260903111000.

export type TaxTypeCategory = 'impuesto' | 'retencion'
export type TaxTypeAppliesAt = 'line' | 'invoice'

/** Catálogo de solo lectura (tax_types) -- códigos de la Tabla 11 del Anexo
 * Técnico DIAN v1.9. 'impuesto' se suma al precio de línea (IVA/IC/ICA/INC);
 * 'retencion' se calcula a nivel de factura completa (ReteIVA/ReteFuente/ReteICA). */
export interface TaxType {
  code: string
  name: string
  category: TaxTypeCategory
  applies_at: TaxTypeAppliesAt
  is_active: boolean
}

/** Catálogo de solo lectura (dian_document_types) -- Tabla 3 del Anexo Técnico. */
export interface DianDocumentType {
  code: string
  name: string
}

export interface TenantDianProfile {
  id: string
  tenant_id: string
  tax_enabled: boolean
  fiscal_regime: 'responsable_iva' | 'no_responsable_iva' | null
  is_self_withholding_agent: boolean
  city: string | null
  resolution_number: string | null
  resolution_prefix: string | null
  resolution_range_from: number | null
  resolution_range_to: number | null
  resolution_valid_from: string | null
  resolution_valid_until: string | null
  next_invoice_number: number | null
  software_id: string | null
  test_set_id: string | null
  webservice_url: string | null
  is_configured: boolean
  created_at: string
  updated_at: string
  deleted_at: string | null
  deleted_by: string | null
}

/** Tarifas de retención que el propio tenant configura (varían por concepto
 * de la operación y cambian con la UVT anual -- no se hardcodean en el
 * catálogo de plataforma, ver comentario en la migración). */
export interface TenantWithholdingConfig {
  id: string
  tenant_id: string
  tax_type_code: string
  concept: string
  rate: number
  is_active: boolean
  created_at: string
  updated_at: string
  deleted_at: string | null
  deleted_by: string | null
}

export type SalesInvoiceStatus =
  | 'pending'
  | 'blocked_missing_buyer_data'
  | 'generating'
  | 'generated'
  | 'sending'
  | 'sent'
  | 'accepted'
  | 'rejected'
  | 'error'
  | 'voided'

export interface SalesInvoice {
  id: string
  tenant_id: string
  order_id: string
  attempt_number: number
  status: SalesInvoiceStatus
  status_detail: string | null
  invoice_prefix: string | null
  invoice_number: number | null
  currency: string
  issue_date: string | null
  buyer_snapshot: Record<string, unknown>
  seller_snapshot: Record<string, unknown>
  subtotal: number
  tax_total: number
  withholding_total: number
  total: number
  cufe: string | null
  xml_storage_path: string | null
  dian_tracking_id: string | null
  dian_response: Record<string, unknown> | null
  sent_at: string | null
  accepted_at: string | null
  rejected_at: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface SalesInvoiceItem {
  id: string
  tenant_id: string
  invoice_id: string
  order_item_id: string | null
  product_name: string
  sku: string | null
  quantity: number
  unit_price: number
  subtotal: number
  tax_type_code: string | null
  tax_rate: number
  tax_amount: number
  taxable_base: number
  display_order: number
  created_at: string
}

export interface SalesInvoiceWithholding {
  id: string
  tenant_id: string
  invoice_id: string
  tax_type_code: string
  concept: string | null
  rate: number
  base: number
  amount: number
  created_at: string
}
