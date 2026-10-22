// Creacion de links de Wompi por los creadores INTERNOS de Leadly (pedido, tienda,
// IA, factura de plataforma): en proceso, sin HTTP ni API key (D3). Pasan por
// createPaymentLink, es decir por la UNICA via de creacion de links, como el cliente
// interno de Leadly (payments.clients.kind='internal', id en PAYMENTS_INTERNAL_CLIENT_ID).
//
// Falla CERRADO: sin PAYMENTS_INTERNAL_CLIENT_ID valido NUNCA se crea el link por otra
// via. El resultado vuelve por el aviso firmado a payments-internal (internalConsumer.ts).
import { ApiError, logEvent, redact } from "./errors.ts";
import { buildPaymentsDeps } from "./buildPaymentsDeps.ts";
import { createPaymentLink, getLink, isUuid, validateLinkRequest } from "./wompiLinks.ts";
import type { Deps } from "./types.ts";

/** Mensaje unico para el usuario final / la IA: nunca nombra variables, ids ni detalles del servicio. */
export const GENERIC_MESSAGE = "No se pudo generar el link de pago en este momento. Intenta de nuevo más tarde.";
const MERCHANT_MESSAGE = "Este comercio no tiene Wompi configurado por completo, por lo que no se puede generar el link de pago.";

export interface InternalLinkOptions {
  /** Solo para pruebas: Deps y clientId inyectados (en produccion salen del entorno). */
  deps?: Deps;
  clientId?: string;
}

let cachedDeps: Deps | null = null;

function internalDeps(opts?: InternalLinkOptions): Deps {
  if (opts?.deps) return opts.deps;
  if (!cachedDeps) {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    if (!supabaseUrl || !serviceRoleKey || !anonKey) {
      logEvent({ level: "critical", event: "payments_internal_creator_misconfigured", reason: "missing_supabase_env" });
      throw new Error(GENERIC_MESSAGE);
    }
    cachedDeps = buildPaymentsDeps({ supabaseUrl, serviceRoleKey, anonKey, cronSecret: Deno.env.get("CRON_REMINDER_SECRET") ?? null });
  }
  return cachedDeps;
}

/** Id del cliente interno (secreto de funcion PAYMENTS_INTERNAL_CLIENT_ID). Lanza si falta o no es uuid. */
export function internalClientId(opts?: InternalLinkOptions): string {
  const id = opts?.clientId ?? Deno.env.get("PAYMENTS_INTERNAL_CLIENT_ID");
  if (!id || !isUuid(id.trim())) {
    logEvent({ level: "critical", event: "payments_internal_creator_misconfigured", reason: "PAYMENTS_INTERNAL_CLIENT_ID missing or not a uuid" });
    throw new Error(GENERIC_MESSAGE);
  }
  return id.trim();
}

/** Detalle tecnico al log (critical); al llamador solo un mensaje generico. */
function toError(e: unknown, op: string): Error {
  if (e instanceof ApiError) {
    logEvent({ level: "critical", event: "payments_internal_creator_failed", op, status: e.status, code: e.code, message: redact(e.message, 300) });
    return new Error(e.code === "merchant_credential_unavailable" || e.code === "merchant_not_active" ? MERCHANT_MESSAGE : GENERIC_MESSAGE);
  }
  if (e instanceof Error && e.message === GENERIC_MESSAGE) return e;
  logEvent({ level: "critical", event: "payments_internal_creator_failed", op, message: redact(e instanceof Error ? e.message : String(e), 300) });
  return new Error(GENERIC_MESSAGE);
}

export interface CreateInternalLinkInput {
  /** Comercio a cuyo nombre se cobra; null = cuenta de plataforma. */
  merchantTenantId: string | null;
  createdBy: string | null;
  idempotencyKey: string;
  /** Cuerpo en el formato publico del servicio (validateLinkRequest lo valida igual que a un externo). */
  request: Record<string, unknown>;
}

/** Crea el link por el servicio. Un link devuelto en 'error' (replay) o sin checkout_url
 * cuenta como fallo del cobro (contrato I6). Lanza Error con mensaje apto para el llamador. */
export async function createInternalPaymentLink(
  input: CreateInternalLinkInput,
  opts?: InternalLinkOptions,
): Promise<{ id: string; checkoutUrl: string; status: string }> {
  const clientId = internalClientId(opts);
  const deps = internalDeps(opts);
  try {
    const request = validateLinkRequest(input.request, deps.now());
    const { link } = await createPaymentLink(deps, {
      clientId,
      createdBy: input.createdBy,
      environment: null, // D4: el ambiente sale de la credencial del comercio
      idempotencyKey: input.idempotencyKey,
      request,
      merchantTenantId: input.merchantTenantId,
    });
    const status = String(link.status);
    const checkoutUrl = typeof link.checkout_url === "string" ? link.checkout_url : "";
    if (status === "error" || !checkoutUrl) throw new Error(GENERIC_MESSAGE);
    return { id: String(link.id), checkoutUrl, status };
  } catch (e) {
    throw toError(e, "create");
  }
}

/** Consulta un link del cliente interno por id (null si no existe). */
export async function getInternalPaymentLink(id: string, opts?: InternalLinkOptions): Promise<Record<string, unknown> | null> {
  const clientId = internalClientId(opts);
  const deps = internalDeps(opts);
  try {
    return await getLink(deps, clientId, { id });
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw toError(e, "get");
  }
}
