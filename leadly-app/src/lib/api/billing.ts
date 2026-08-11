import { supabase } from '../supabaseClient'
import type { BillingPlan, BillingSubscription, PaymentAttempt, PaymentInvoice, PaymentInvoiceItem, PaymentInvoiceWithTenant } from '../../types/domain'

export interface BillingPlanInput {
  key: string
  name: string
  description: string | null
  amount_cents: number
  currency: string
  billing_interval: 'monthly' | 'yearly'
  is_active: boolean
  max_users: number | null
  max_whatsapp_lines: number | null
}

export async function listBillingPlans(): Promise<BillingPlan[]> {
  const { data, error } = await supabase.from('billing_plans').select('*').order('amount_cents')
  if (error) throw error
  return data
}

export async function createBillingPlan(input: BillingPlanInput): Promise<BillingPlan> {
  const { data, error } = await supabase.from('billing_plans').insert(input).select().single()
  if (error) throw error
  return data
}

export async function updateBillingPlan(id: string, input: BillingPlanInput): Promise<BillingPlan> {
  const { data, error } = await supabase.from('billing_plans').update(input).eq('id', id).select().single()
  if (error) throw error
  return data
}

/** Assigns a tenant to a plan, creating (or re-pointing) its subscription.
 * Starts as PENDING_PAYMENT -- becomes ACTIVE once its first invoice is paid
 * (see activate_subscription_on_invoice_paid trigger). */
export async function assignTenantToPlan(tenantId: string, planId: string): Promise<BillingSubscription> {
  const { data, error } = await supabase
    .from('billing_subscriptions')
    .insert({ tenant_id: tenantId, plan_id: planId, status: 'PENDING_PAYMENT' })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function getActiveSubscriptionForTenant(tenantId: string): Promise<BillingSubscription | null> {
  const { data, error } = await supabase
    .from('billing_subscriptions')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return data
}

/** Max active users the tenant's current plan allows -- null means either no
 * plan assigned yet or the plan has no limit. UI-side mirror of the same
 * lookup enforce_plan_max_users() does server-side, so "Invitar usuario" can
 * be disabled proactively instead of only failing after submit. */
export async function getMaxUsersForTenant(tenantId: string): Promise<number | null> {
  const { data, error } = await supabase
    .from('billing_subscriptions')
    .select('plan:billing_plans(max_users)')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return (data?.plan as unknown as { max_users: number | null } | null)?.max_users ?? null
}

/** Max active WhatsApp lines the tenant's current plan allows -- null means
 * either no plan assigned yet or the plan has no limit. UI-side mirror of
 * enforce_plan_max_whatsapp_lines(), same reasoning as getMaxUsersForTenant. */
export async function getMaxWhatsappLinesForTenant(tenantId: string): Promise<number | null> {
  const { data, error } = await supabase
    .from('billing_subscriptions')
    .select('plan:billing_plans(max_whatsapp_lines)')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return (data?.plan as unknown as { max_whatsapp_lines: number | null } | null)?.max_whatsapp_lines ?? null
}

export async function listInvoicesForTenant(tenantId: string): Promise<PaymentInvoice[]> {
  const { data, error } = await supabase
    .from('payment_invoices')
    .select('*')
    .eq('payer_tenant_id', tenantId)
    .order('created_at', { ascending: false })
  if (error) throw error
  return data
}

/** Cancels a subscription like Netflix/Amazon: if it's usable for a paid,
 * in-progress period, this only schedules the cancellation
 * (cancel_at_period_end) -- the tenant stays active until that period ends,
 * the cron just stops billing the next one. Only cancels immediately if
 * there's no active paid period to honor (e.g. still PENDING_PAYMENT).
 * Branching logic lives in the cancel_subscription() RPC, not here, so it's
 * enforced the same way regardless of caller. */
export async function cancelSubscription(subscriptionId: string): Promise<BillingSubscription> {
  const { data, error } = await supabase.rpc('cancel_subscription', { p_subscription_id: subscriptionId })
  if (error) throw error
  return data as BillingSubscription
}

/** Undoes a scheduled cancellation (cancel_at_period_end) before the period
 * runs out. */
export async function reactivateSubscription(subscriptionId: string): Promise<BillingSubscription> {
  const { data, error } = await supabase.rpc('reactivate_subscription', { p_subscription_id: subscriptionId })
  if (error) throw error
  return data as BillingSubscription
}

export async function listAllInvoices(): Promise<PaymentInvoiceWithTenant[]> {
  const { data, error } = await supabase
    .from('payment_invoices')
    .select('*, tenant:tenants!payer_tenant_id(name)')
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
  if (error) throw error
  return data as unknown as PaymentInvoiceWithTenant[]
}

export interface RecordManualPaymentInput {
  amountCents: number
  paymentMethod: string
  paymentReference: string | null
  note: string | null
}

/** Marks an invoice PAID for a payment collected outside Wompi (bank
 * transfer, cash, etc.) -- the only path to PAID previously was the Wompi
 * webhook / sync-payment-invoices. Runs through record_manual_payment
 * (security definer, superadmin-only), which records the payment_attempts
 * row and flips the invoice the same way applyWebhookEvent does, so
 * activate_subscription_on_invoice_paid fires identically either way. */
export async function recordManualPayment(invoiceId: string, input: RecordManualPaymentInput): Promise<PaymentInvoice> {
  const { data, error } = await supabase.rpc('record_manual_payment', {
    p_invoice_id: invoiceId,
    p_amount_cents: input.amountCents,
    p_payment_method: input.paymentMethod,
    p_payment_reference: input.paymentReference,
    p_note: input.note,
  })
  if (error) throw error
  return data as PaymentInvoice
}

export interface ManualInvoiceItemInput {
  description: string
  quantity: number
  unitPriceCents: number
}

export interface ManualInvoiceInput {
  payerTenantId: string
  subscriptionId: string | null
  providerKey: string
  currency: string
  dueDate: string | null
  /** IVA rate (%) for this invoice. Omitted uses the column default (19,
   * the general Colombian rate) -- set explicitly for a case that shouldn't
   * carry the general rate (e.g. an excluded/exempt charge). */
  taxRate?: number
  /** At least one line item -- the invoice's amount_cents/description are
   * derived from these, not entered separately, so what's on the invoice
   * always matches what's actually being charged. */
  items: ManualInvoiceItemInput[]
}

/** Superadmin-only manual invoice, for a one-off charge outside the
 * recurring billing cycle (process_recurring_billing_invoices handles the
 * automatic case). merchant_tenant_id stays null: Leadly is always the
 * merchant for tenant subscription billing. The buyer snapshot and tax
 * breakdown are filled server-side by the snapshot_invoice_buyer_and_tax
 * trigger; amount_cents/description are derived here from `items` and the
 * items themselves are inserted right after, rolling back the invoice if
 * that insert fails (same partial-failure rollback pattern as
 * createWhatsappLine). */
export async function createManualInvoice(input: ManualInvoiceInput): Promise<PaymentInvoice> {
  const itemRows = input.items.map((item, i) => ({
    description: item.description,
    quantity: item.quantity,
    unit_price_cents: item.unitPriceCents,
    subtotal_cents: Math.round(item.quantity * item.unitPriceCents),
    display_order: i,
  }))
  const amountCents = itemRows.reduce((sum, item) => sum + item.subtotal_cents, 0)
  const description = itemRows.length === 1 ? itemRows[0].description : `${itemRows[0].description} +${itemRows.length - 1} más`

  const { data: invoice, error: invoiceError } = await supabase
    .from('payment_invoices')
    .insert({
      merchant_tenant_id: null,
      payer_tenant_id: input.payerTenantId,
      subscription_id: input.subscriptionId,
      provider_key: input.providerKey,
      amount_cents: amountCents,
      currency: input.currency,
      description,
      due_date: input.dueDate,
      status: 'PENDING',
      ...(input.taxRate !== undefined ? { tax_rate: input.taxRate } : {}),
    })
    .select()
    .single()
  if (invoiceError) throw invoiceError

  const { error: itemsError } = await supabase
    .from('payment_invoice_items')
    .insert(itemRows.map((item) => ({ ...item, invoice_id: invoice.id })))
  if (itemsError) {
    await supabase.from('payment_invoices').delete().eq('id', invoice.id)
    throw itemsError
  }

  return invoice
}

export async function listItemsForInvoice(invoiceId: string): Promise<PaymentInvoiceItem[]> {
  const { data, error } = await supabase
    .from('payment_invoice_items')
    .select('*')
    .eq('invoice_id', invoiceId)
    .order('display_order', { ascending: true })
  if (error) throw error
  return data
}

export async function listAttemptsForInvoice(invoiceId: string): Promise<PaymentAttempt[]> {
  const { data, error } = await supabase.from('payment_attempts').select('*').eq('invoice_id', invoiceId).order('created_at', { ascending: false })
  if (error) throw error
  return data
}

/** Calls create-payment-checkout: creates (or reuses) a hosted checkout URL
 * for a pending invoice. Throws with the Edge Function's own error message
 * when available, same pattern as sendHumanMessage in conversations.ts. */
export async function createCheckoutForInvoice(invoiceId: string, redirectUrl?: string): Promise<string> {
  const { data, error } = await supabase.functions.invoke('create-payment-checkout', {
    body: { invoice_id: invoiceId, redirect_url: redirectUrl },
  })
  if (error) {
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
  if (data?.error) throw new Error(data.error)
  return data.checkoutUrl
}

export async function syncPaymentInvoices(invoiceId?: string): Promise<void> {
  const { data, error } = await supabase.functions.invoke('sync-payment-invoices', {
    body: invoiceId ? { invoice_id: invoiceId } : {},
  })
  if (error) throw error
  if (data?.error) throw new Error(data.error)
}

// --- Wompi payment credential (platform = Leadly's own keys, tenant = that
// tenant's own merchant account) -- both scopes share tenant_payment_credentials,
// distinguished only by tenant_id being null vs set. -------------------------

const WOMPI_PROVIDER_KEY = 'wompi'

async function getWompiCredentialId(tenantId: string | null): Promise<string | null> {
  let query = supabase.from('tenant_payment_credentials').select('id').eq('provider_key', WOMPI_PROVIDER_KEY).is('deleted_at', null)
  query = tenantId ? query.eq('tenant_id', tenantId) : query.is('tenant_id', null)
  const { data, error } = await query.maybeSingle()
  if (error) throw error
  return data?.id ?? null
}

async function ensureWompiCredential(tenantId: string | null, mode: 'sandbox' | 'production'): Promise<string> {
  const existingId = await getWompiCredentialId(tenantId)
  if (existingId) return existingId
  const { data, error } = await supabase
    .from('tenant_payment_credentials')
    .insert({ tenant_id: tenantId, provider_key: WOMPI_PROVIDER_KEY, mode })
    .select('id')
    .single()
  if (error) throw error
  return data.id
}

export async function getPaymentCredentialStatus(tenantId: string | null): Promise<{ credentialId: string | null; mode: 'sandbox' | 'production'; configuredSecrets: string[] }> {
  const credentialId = await getWompiCredentialId(tenantId)
  if (!credentialId) return { credentialId: null, mode: 'sandbox', configuredSecrets: [] }

  const { data: credential, error: credentialError } = await supabase
    .from('tenant_payment_credentials')
    .select('mode')
    .eq('id', credentialId)
    .single()
  if (credentialError) throw credentialError

  const { data: configured, error: configuredError } = await supabase.rpc('payment_credential_configured_secrets', { p_credential_id: credentialId })
  if (configuredError) throw configuredError

  return { credentialId, mode: credential.mode, configuredSecrets: (configured as string[]) ?? [] }
}

export async function setPaymentMode(tenantId: string | null, mode: 'sandbox' | 'production'): Promise<void> {
  const credentialId = await ensureWompiCredential(tenantId, mode)
  const { error } = await supabase.from('tenant_payment_credentials').update({ mode }).eq('id', credentialId)
  if (error) throw error
}

export async function setPaymentCredentialSecret(tenantId: string | null, secretName: 'private_key' | 'integrity_key', value: string): Promise<void> {
  const credentialId = await ensureWompiCredential(tenantId, 'sandbox')
  const { error } = await supabase.rpc('set_payment_credential_secret', {
    p_credential_id: credentialId,
    p_secret_name: secretName,
    p_secret_value: value,
  })
  if (error) throw error
}
