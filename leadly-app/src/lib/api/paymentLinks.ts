import { supabase } from '../supabaseClient'

/**
 * Cliente de las rutas /admin de la Edge Function `payments-api`
 * (contrato normativo: progress/payments_interface_spec.md §3 y §5).
 *
 * Único módulo del frontend que habla con `payments-api`. Usa la sesión del
 * superadmin (JWT); la función valida `profiles.role = 'superadmin'`. Nunca
 * recibe `tenant_id` ni ninguna API key.
 *
 * El contrato fija las rutas y los campos de entrada; las FORMAS de respuesta
 * de las listas admin no están escritas en el contrato (solo lo está
 * `payments_list_links` -> `{ items, next_before }`). Por eso `unwrapList` /
 * `unwrapClient` aceptan array directo o un envoltorio `{ items | clients |
 * data }` / `{ client }`. Si P2 devuelve otra forma, se corrige aquí.
 */

export type PaymentClientStatus = 'active' | 'suspended'

export interface PaymentClient {
  id: string
  name: string
  status: PaymentClientStatus
  key_prefix: string | null
  callback_url: string | null
  signing_secret_name: string | null
  created_at: string
  updated_at: string
  revoked_at: string | null
}

export type PaymentLinkStatus = 'creating' | 'pending' | 'paid' | 'voided' | 'expired' | 'cancelled' | 'error'

export interface PaymentLink {
  id: string
  client_id: string
  external_reference: string
  amount_in_cents: number
  currency: string
  environment: 'sandbox' | 'production'
  name: string
  description: string | null
  redirect_url: string | null
  expires_at: string | null
  status: PaymentLinkStatus
  status_detail: string | null
  checkout_url: string | null
  paid_transaction_id: string | null
  paid_at: string | null
  created_at: string
  updated_at: string
}

/** Conteos de `payments_health_summary` (últimas 24 h; contrato §7). */
export interface PaymentHealth {
  invalid_signature: number
  unverified: number
  verification_mismatch: number
  transaction_conflict: number
  amount_mismatch: number
  duplicate_payment: number
  deliveries_failed: number
  stale_pending_links: number
}

export interface PaymentReadiness {
  platform_credential: { configured: boolean; mode: string | null }
  events_url: string
  clients_active: number
  /** Ausente si el backend no lo envía: NO se trata como cero. */
  health?: PaymentHealth | null
}

/** Respuesta de POST /admin/clients: las dos credenciales viajan UNA sola vez. */
export interface CreatedPaymentClient {
  client: PaymentClient
  api_key: string
  signing_secret: string
}

/** Respuesta de POST /admin/clients/{id}/rotate-key: la clave nueva, una sola vez. */
export interface RotatedPaymentKey {
  api_key: string
}

export interface PaymentLinksPage {
  items: PaymentLink[]
  next_before: string | null
}

export interface ListPaymentLinksParams {
  clientId?: string | null
  status?: PaymentLinkStatus | null
  before?: string | null
}

/** Cuerpo de POST /admin/links (mismo cuerpo que POST /v1/payment-links más
 * `client_id` e `idempotency_key`). Montos SIEMPRE en centavos aquí. */
export interface CreatePaymentLinkInput {
  clientId: string
  idempotencyKey: string
  amountInCents: number
  name: string
  description: string
  externalReference: string
  redirectUrl?: string | null
  expiresAt?: string | null
}

export interface CreatedPaymentLink {
  id: string
  status: PaymentLinkStatus
  checkout_url: string | null
  external_reference: string
  amount_in_cents: number
  currency: string
  expires_at: string | null
  created_at: string
}

/** ÚNICO punto donde pesos pasan a centavos (COP, v1). El contrato exige
 * `amount_in_cents` entero >= 1; aquí solo se convierte, la validez de
 * negocio la decide el backend. */
export function pesosToCents(pesos: number): number {
  return Math.round(pesos * 100)
}

/** Inverso, solo para mostrar. */
export function centsToPesos(cents: number): number {
  return cents / 100
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID()
}

type Method = 'GET' | 'POST' | 'PATCH'

async function extractErrorMessage(error: unknown, fallback: string): Promise<string> {
  const context = (error as { context?: Response }).context
  if (context && typeof context.json === 'function') {
    try {
      const body = await context.json()
      const raw = body?.error
      if (typeof raw === 'string' && raw) return typeof body?.message === 'string' && body.message ? `${raw}: ${body.message}` : raw
      if (raw && typeof raw.message === 'string') return raw.message
      if (typeof body?.message === 'string' && body.message) return body.message
    } catch {
      /* cae al mensaje genérico */
    }
  }
  return error instanceof Error && error.message ? error.message : fallback
}

async function call<T>(path: string, method: Method, body?: unknown): Promise<T> {
  const { data, error } = await supabase.functions.invoke<T & { error?: unknown }>(`payments-api/${path}`, {
    method,
    ...(body !== undefined ? { body: body as Record<string, unknown> } : {}),
  })
  if (error) throw new Error(await extractErrorMessage(error, 'No se pudo completar la operación con payments-api.'))
  if (data == null) throw new Error('payments-api respondió vacío.')
  const maybeError = (data as { error?: unknown }).error
  if (maybeError) throw new Error(typeof maybeError === 'string' ? maybeError : JSON.stringify(maybeError))
  return data as T
}

function unwrapList<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[]
  const obj = raw as { items?: T[]; clients?: T[]; data?: T[] } | null
  return obj?.items ?? obj?.clients ?? obj?.data ?? []
}

function unwrapClient(raw: unknown): PaymentClient {
  const obj = raw as { client?: PaymentClient } | null
  return (obj?.client ?? raw) as PaymentClient
}

export function getPaymentReadiness(): Promise<PaymentReadiness> {
  return call<PaymentReadiness>('admin/readiness', 'GET')
}

export async function listPaymentClients(): Promise<PaymentClient[]> {
  return unwrapList<PaymentClient>(await call<unknown>('admin/clients', 'GET'))
}

export function createPaymentClient(input: { name: string; callbackUrl?: string | null }): Promise<CreatedPaymentClient> {
  return call<CreatedPaymentClient>('admin/clients', 'POST', {
    name: input.name,
    ...(input.callbackUrl ? { callback_url: input.callbackUrl } : {}),
  })
}

export function rotatePaymentClientKey(id: string): Promise<RotatedPaymentKey> {
  return call<RotatedPaymentKey>(`admin/clients/${encodeURIComponent(id)}/rotate-key`, 'POST')
}

export async function updatePaymentClient(
  id: string,
  patch: { status?: PaymentClientStatus; callbackUrl?: string | null },
): Promise<PaymentClient> {
  const body: Record<string, unknown> = {}
  if (patch.status !== undefined) body.status = patch.status
  if (patch.callbackUrl !== undefined) body.callback_url = patch.callbackUrl
  return unwrapClient(await call<unknown>(`admin/clients/${encodeURIComponent(id)}`, 'PATCH', body))
}

export async function listPaymentLinks(params: ListPaymentLinksParams = {}): Promise<PaymentLinksPage> {
  const qs = new URLSearchParams()
  if (params.clientId) qs.set('client_id', params.clientId)
  if (params.status) qs.set('status', params.status)
  if (params.before) qs.set('before', params.before)
  const query = qs.toString()
  const raw = await call<unknown>(`admin/links${query ? `?${query}` : ''}`, 'GET')
  const obj = raw as { next_before?: string | null } | null
  return { items: unwrapList<PaymentLink>(raw), next_before: obj?.next_before ?? null }
}

export function createPaymentLink(input: CreatePaymentLinkInput): Promise<CreatedPaymentLink> {
  return call<CreatedPaymentLink>('admin/links', 'POST', {
    client_id: input.clientId,
    idempotency_key: input.idempotencyKey,
    amount_in_cents: input.amountInCents,
    currency: 'COP',
    name: input.name,
    description: input.description,
    external_reference: input.externalReference,
    ...(input.redirectUrl ? { redirect_url: input.redirectUrl } : {}),
    ...(input.expiresAt ? { expires_at: input.expiresAt } : {}),
  })
}
