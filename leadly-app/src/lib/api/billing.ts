import { supabase } from '../supabaseClient'
import type { BillingPlan, BillingSubscription, PaymentAttempt, PaymentInvoice } from '../../types/domain'

export interface BillingPlanInput {
  key: string
  name: string
  description: string | null
  amount_cents: number
  currency: string
  billing_interval: 'monthly' | 'yearly'
  is_active: boolean
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

export async function listInvoicesForTenant(tenantId: string): Promise<PaymentInvoice[]> {
  const { data, error } = await supabase
    .from('payment_invoices')
    .select('*')
    .eq('payer_tenant_id', tenantId)
    .order('created_at', { ascending: false })
  if (error) throw error
  return data
}

export interface ManualInvoiceInput {
  payerTenantId: string
  subscriptionId: string | null
  providerKey: string
  amountCents: number
  currency: string
  description: string
  dueDate: string | null
}

/** Superadmin-only manual invoice, for a one-off charge outside the
 * recurring billing cycle (process_recurring_billing_invoices handles the
 * automatic case). merchant_tenant_id stays null: Leadly is always the
 * merchant for tenant subscription billing. */
export async function createManualInvoice(input: ManualInvoiceInput): Promise<PaymentInvoice> {
  const { data, error } = await supabase
    .from('payment_invoices')
    .insert({
      merchant_tenant_id: null,
      payer_tenant_id: input.payerTenantId,
      subscription_id: input.subscriptionId,
      provider_key: input.providerKey,
      amount_cents: input.amountCents,
      currency: input.currency,
      description: input.description,
      due_date: input.dueDate,
      status: 'PENDING',
    })
    .select()
    .single()
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

// --- Platform payment credential (Leadly's own Wompi keys) ---------------

const PLATFORM_PROVIDER_KEY = 'wompi'

async function getPlatformCredentialId(): Promise<string | null> {
  const { data, error } = await supabase
    .from('tenant_payment_credentials')
    .select('id')
    .eq('provider_key', PLATFORM_PROVIDER_KEY)
    .is('tenant_id', null)
    .is('deleted_at', null)
    .maybeSingle()
  if (error) throw error
  return data?.id ?? null
}

async function ensurePlatformCredential(mode: 'sandbox' | 'production'): Promise<string> {
  const existingId = await getPlatformCredentialId()
  if (existingId) return existingId
  const { data, error } = await supabase
    .from('tenant_payment_credentials')
    .insert({ tenant_id: null, provider_key: PLATFORM_PROVIDER_KEY, mode })
    .select('id')
    .single()
  if (error) throw error
  return data.id
}

export async function getPlatformPaymentCredentialStatus(): Promise<{ credentialId: string | null; mode: 'sandbox' | 'production'; configuredSecrets: string[] }> {
  const credentialId = await getPlatformCredentialId()
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

export async function setPlatformPaymentMode(mode: 'sandbox' | 'production'): Promise<void> {
  const credentialId = await ensurePlatformCredential(mode)
  const { error } = await supabase.from('tenant_payment_credentials').update({ mode }).eq('id', credentialId)
  if (error) throw error
}

export async function setPlatformPaymentCredentialSecret(secretName: 'private_key' | 'integrity_key', value: string): Promise<void> {
  const credentialId = await ensurePlatformCredential('sandbox')
  const { error } = await supabase.rpc('set_payment_credential_secret', {
    p_credential_id: credentialId,
    p_secret_name: secretName,
    p_secret_value: value,
  })
  if (error) throw error
}
