import { resolveFunctionsRegion, withFunctionsRegion } from '../functionsRegion'

/**
 * Cliente de la ruta PÚBLICA de estado de un cobro de `payments-api`:
 *   GET {SUPABASE_URL}/functions/v1/payments-api/v1/public/payment-links/{id}/status
 *
 * Es la única llamada de la página de retorno de Wompi (/pago/resultado). A
 * propósito NO usa el cliente `supabase` ni manda ningún header: la ruta es
 * pública, no necesita Authorization, y el interceptor de sesión de
 * `supabaseClient.ts` cerraría una sesión abierta ante un 401 que aquí no aplica.
 *
 * REGLA DE ORO: el estado lo decide el backend por el webhook de Wompi. Ningún
 * query param que agregue Wompi (p. ej. ?id=) participa en la decisión.
 */

export type PaymentLinkStatus = 'paid' | 'pending' | 'expired' | 'cancelled' | 'voided' | 'error' | 'unknown'
export type PaymentAttempt = 'APPROVED' | 'DECLINED' | 'VOIDED' | 'ERROR'

export interface PublicPaymentStatus {
  status: PaymentLinkStatus
  lastAttempt: PaymentAttempt | null
  updatedAt: string | null
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Tolera que Wompi agregue su propio parámetro pegado al nuestro (p. ej.
// `?link=<uuid>?id=...` si no maneja la query ya existente): solo se toma el
// UUID del inicio. Nunca se usa nada de lo que viene después.
const UUID_PREFIX_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?![0-9a-f-])/i

const STATUSES: readonly PaymentLinkStatus[] = ['paid', 'pending', 'expired', 'cancelled', 'voided', 'error', 'unknown']
const ATTEMPTS: readonly PaymentAttempt[] = ['APPROVED', 'DECLINED', 'VOIDED', 'ERROR']

/** Devuelve el id del cobro si `raw` es (o empieza con) un UUID válido; si no, null. */
export function parsePaymentLinkId(raw: string | null | undefined): string | null {
  if (!raw) return null
  const value = raw.trim()
  if (UUID_RE.test(value)) return value.toLowerCase()
  const m = UUID_PREFIX_RE.exec(value)
  return m ? m[1].toLowerCase() : null
}

/** Normaliza la respuesta del backend: cualquier valor fuera del contrato cae a "unknown"/null. */
export function parsePublicStatus(body: unknown): PublicPaymentStatus {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const status = STATUSES.includes(b.status as PaymentLinkStatus) ? (b.status as PaymentLinkStatus) : 'unknown'
  const lastAttempt = ATTEMPTS.includes(b.last_attempt as PaymentAttempt) ? (b.last_attempt as PaymentAttempt) : null
  const updatedAt = typeof b.updated_at === 'string' ? b.updated_at : null
  return { status, lastAttempt, updatedAt }
}

export class PaymentStatusRequestError extends Error {}

export async function fetchPublicPaymentStatus(id: string, signal?: AbortSignal): Promise<PublicPaymentStatus> {
  const base = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.replace(/\/+$/, '')
  if (!base) throw new PaymentStatusRequestError('Missing VITE_SUPABASE_URL')
  const url = `${base}/functions/v1/payments-api/v1/public/payment-links/${encodeURIComponent(id)}/status`
  const region = resolveFunctionsRegion(import.meta.env.VITE_SUPABASE_FUNCTIONS_REGION as string | undefined)
  const target = withFunctionsRegion(url, base, region)
  let res: Response
  try {
    res = await fetch(target, { method: 'GET', cache: 'no-store', credentials: 'omit', signal })
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e
    throw new PaymentStatusRequestError('network')
  }
  if (!res.ok) throw new PaymentStatusRequestError(`http_${res.status}`)
  let json: unknown
  try {
    json = await res.json()
  } catch {
    throw new PaymentStatusRequestError('invalid_body')
  }
  return parsePublicStatus(json)
}
