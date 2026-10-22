// Creación y consulta de links de pago. Única vía de creación (el antiguo
// wompiAdapter.createCheckout, con IVA 19% fijo, se retiró): arma su llamada a
// POST {api}/payment_links, sin `taxes` salvo que vengan explícitos.
import { wompiAdapter } from "../payments/wompi.ts";
import { ApiError, callRpc, logEvent, redact } from "./errors.ts";
import { canonicalJson, sha256Hex } from "./hmac.ts";
import { paymentReturnUrl } from "../publicAppUrl.ts";
import { WOMPI_TIMEOUT_MS } from "./types.ts";
import type { Deps, PayEnvironment } from "./types.ts";

export const WOMPI_API: Record<PayEnvironment, string> = {
  sandbox: "https://sandbox.wompi.co/v1",
  production: "https://production.wompi.co/v1",
};

const ALLOWED_FIELDS = new Set([
  "amount_in_cents",
  "currency",
  "name",
  "description",
  "external_reference",
  "redirect_url",
  "expires_at",
  "metadata",
  "taxes",
  "customer",
]);
// `merchant`/`merchant_tenant_id`: solo el cliente interno fija el comercio, y lo
// hace en proceso (CreateLinkInput.merchantTenantId), nunca por el cuerpo publico.
const FORBIDDEN_FIELDS = new Set(["client_id", "account", "environment", "merchant", "merchant_tenant_id"]);
const IDEMPOTENCY_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

export interface TaxInput {
  type: "VAT" | "CONSUMPTION";
  amount_in_cents: number;
}

export interface LinkRequest {
  amount_in_cents: number;
  currency: "COP";
  name: string;
  description: string;
  external_reference: string;
  redirect_url: string | null;
  expires_at: string | null;
  metadata: Record<string, unknown>;
  taxes: TaxInput[] | null;
  customer: Record<string, string> | null;
}

function invalid(code: string, message: string): never {
  throw new ApiError(422, code, message);
}

function str(v: unknown, field: string, min: number, max: number): string {
  if (typeof v !== "string") invalid("invalid_field", `${field} debe ser texto.`);
  const t = (v as string).trim();
  if (t.length < min || t.length > max) invalid("invalid_field", `${field} debe tener entre ${min} y ${max} caracteres.`);
  return t;
}

/** Valida y normaliza el cuerpo de creación. `extraAllowed` permite campos de
 * la ruta admin (client_id / idempotency_key) que ya fueron extraídos antes. */
export function validateLinkRequest(raw: unknown, nowMs: number): LinkRequest {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ApiError(400, "invalid_json", "El cuerpo debe ser un objeto JSON.");
  }
  const body = raw as Record<string, unknown>;
  for (const k of Object.keys(body)) {
    if (FORBIDDEN_FIELDS.has(k)) invalid("field_not_allowed", `El campo "${k}" no se permite: el proyecto, el comercio y el ambiente no se envían en el cuerpo.`);
  }
  for (const k of Object.keys(body)) {
    if (!ALLOWED_FIELDS.has(k)) invalid("field_not_allowed", `El campo "${k}" no es parte del contrato.`);
  }

  const amount = body.amount_in_cents;
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 1 || amount > 1_000_000_000_000) {
    invalid("invalid_amount", "amount_in_cents debe ser un entero >= 1.");
  }
  if (body.currency !== "COP") invalid("currency_not_supported", 'Solo se admite currency "COP".');

  const name = str(body.name, "name", 1, 150);
  const description = str(body.description, "description", 1, 500);
  const externalReference = str(body.external_reference, "external_reference", 1, 128);

  let redirectUrl: string | null = null;
  if (body.redirect_url !== undefined && body.redirect_url !== null) {
    const r = str(body.redirect_url, "redirect_url", 1, 2048);
    let u: URL;
    try {
      u = new URL(r);
    } catch {
      return invalid("invalid_redirect_url", "redirect_url no es una URL válida.");
    }
    if (u.protocol !== "https:") invalid("invalid_redirect_url", "redirect_url debe ser https.");
    if (u.username || u.password) invalid("invalid_redirect_url", "redirect_url no puede traer credenciales.");
    redirectUrl = u.toString();
  }

  let expiresAt: string | null = null;
  if (body.expires_at !== undefined && body.expires_at !== null) {
    const e = str(body.expires_at, "expires_at", 1, 40);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(e)) {
      invalid("invalid_expires_at", "expires_at debe ser ISO 8601 con zona horaria (ej. 2026-12-31T23:59:59Z).");
    }
    const t = Date.parse(e);
    if (Number.isNaN(t)) invalid("invalid_expires_at", "expires_at no es una fecha válida.");
    if (t <= nowMs) invalid("invalid_expires_at", "expires_at debe estar en el futuro.");
    expiresAt = new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  let metadata: Record<string, unknown> = {};
  if (body.metadata !== undefined && body.metadata !== null) {
    if (typeof body.metadata !== "object" || Array.isArray(body.metadata)) invalid("invalid_metadata", "metadata debe ser un objeto.");
    if (JSON.stringify(body.metadata).length > 4096) invalid("invalid_metadata", "metadata no puede superar 4 KB.");
    metadata = body.metadata as Record<string, unknown>;
  }

  let taxes: TaxInput[] | null = null;
  if (body.taxes !== undefined && body.taxes !== null) {
    if (!Array.isArray(body.taxes) || body.taxes.length === 0 || body.taxes.length > 2) {
      invalid("invalid_taxes", "taxes debe ser una lista de 1 o 2 impuestos.");
    }
    taxes = (body.taxes as unknown[]).map((t) => {
      const tx = t as Record<string, unknown>;
      if (!t || typeof t !== "object" || (tx.type !== "VAT" && tx.type !== "CONSUMPTION")) {
        return invalid("invalid_taxes", 'Cada impuesto debe tener type "VAT" o "CONSUMPTION".');
      }
      if (typeof tx.amount_in_cents !== "number" || !Number.isSafeInteger(tx.amount_in_cents) || tx.amount_in_cents < 0) {
        return invalid("invalid_taxes", "amount_in_cents del impuesto debe ser un entero >= 0.");
      }
      return { type: tx.type, amount_in_cents: tx.amount_in_cents } as TaxInput;
    });
    if (taxes.reduce((s, t) => s + t.amount_in_cents, 0) > (amount as number)) invalid("invalid_taxes", "La suma de impuestos supera el monto.");
  }

  // `customer`: el contrato de Wompi para /payment_links NO documenta campos de
  // pagador (solo customer_data.customer_references), así que se valida y se
  // conserva en el registro del servicio pero NO se envía a Wompi.
  let customer: Record<string, string> | null = null;
  if (body.customer !== undefined && body.customer !== null) {
    if (typeof body.customer !== "object" || Array.isArray(body.customer)) invalid("invalid_customer", "customer debe ser un objeto.");
    const c = body.customer as Record<string, unknown>;
    const allowed = ["email", "name", "phone", "legal_id", "legal_id_type"];
    customer = {};
    for (const [k, v] of Object.entries(c)) {
      if (!allowed.includes(k)) invalid("invalid_customer", `customer.${k} no es un campo admitido.`);
      customer[k] = str(v, `customer.${k}`, 1, 120);
    }
  }

  return {
    amount_in_cents: amount as number,
    currency: "COP",
    name,
    description,
    external_reference: externalReference,
    redirect_url: redirectUrl,
    expires_at: expiresAt,
    metadata,
    taxes,
    customer,
  };
}

export function validateIdempotencyKey(v: unknown): string {
  if (typeof v !== "string" || !IDEMPOTENCY_RE.test(v)) {
    throw new ApiError(400, "invalid_idempotency_key", "Idempotency-Key es obligatorio: 1-128 caracteres [A-Za-z0-9._:-].");
  }
  return v;
}

/** Proyección pública de un link (nunca expone wompi_link_id ni hashes). */
export function projectLink(link: Record<string, unknown>): Record<string, unknown> {
  const le = link.last_event as Record<string, unknown> | null | undefined;
  const lastEvent = le && typeof le === "object"
    ? {
      id: le.id ?? null,
      classification: le.classification ?? null,
      transaction_id: le.transaction_id ?? null,
      tx_status: le.tx_status ?? null,
      amount_in_cents: le.amount_in_cents ?? null,
      received_at: le.received_at ?? null,
    }
    : null;
  return {
    id: link.id,
    status: link.status,
    status_detail: link.status_detail ?? null,
    checkout_url: link.checkout_url ?? null,
    external_reference: link.external_reference,
    environment: link.environment,
    amount_in_cents: link.amount_in_cents,
    currency: link.currency,
    expires_at: link.expires_at ?? null,
    created_at: link.created_at,
    updated_at: link.updated_at ?? null,
    paid_at: link.paid_at ?? null,
    paid_transaction_id: link.paid_transaction_id ?? null,
    metadata: link.metadata ?? {},
    last_event: lastEvent,
  };
}

export interface CreateLinkInput {
  clientId: string;
  createdBy: string | null;
  /** null = usar el modo de la credencial de plataforma (rutas admin). */
  environment: PayEnvironment | null;
  idempotencyKey: string;
  request: LinkRequest;
  /** Comercio (tenant) a cuyo nombre se cobra; null/ausente = cuenta de plataforma.
   * Solo lo usan los creadores internos (payments_begin_link lo exige `internal`). */
  merchantTenantId?: string | null;
}

export interface CreateLinkResult {
  link: Record<string, unknown>;
  replayed: boolean;
}

async function postWompi(deps: Deps, env: PayEnvironment, privateKey: string, body: Record<string, unknown>) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), deps.timeouts?.wompiMs ?? WOMPI_TIMEOUT_MS);
  try {
    return await deps.fetch(`${WOMPI_API[env]}/payment_links`, {
      method: "POST",
      headers: { Authorization: `Bearer ${privateKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctl.signal,
      redirect: "error",
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function createPaymentLink(deps: Deps, input: CreateLinkInput): Promise<CreateLinkResult> {
  const { request } = input;
  const merchant = input.merchantTenantId ?? null;
  if (merchant !== null && !isUuid(merchant)) invalid("invalid_merchant", "merchant_tenant_id debe ser un uuid.");
  // Para el hash de idempotencia solo cuenta lo que define el pedido. El comercio
  // entra al hash solo cuando existe: los links de plataforma conservan su hash
  // historico (misma Idempotency-Key => mismo resultado que antes).
  const requestHash = await sha256Hex(canonicalJson(merchant === null ? request : { ...request, merchant_tenant_id: merchant }));

  // Credencial: la del comercio (null = plataforma). Falla CERRADO: un comercio
  // sin credencial activa NUNCA cae a la cuenta de plataforma.
  const loadCredential = async () => {
    if (merchant === null) return await deps.getPlatformCredential();
    try {
      return await deps.getMerchantCredential(merchant);
    } catch {
      return null;
    }
  };
  const credentialMissing = (): ApiError =>
    merchant === null
      ? new ApiError(503, "platform_credential_unavailable", "La credencial de Wompi de la plataforma no está configurada.")
      : new ApiError(409, "merchant_credential_unavailable", "El comercio no tiene una credencial de Wompi activa y completa.");
  const credentialDetail = merchant === null ? "platform_credential_unavailable" : "merchant_credential_unavailable";

  // Ambiente (D4): interno/admin (environment null) = modo de la credencial del
  // comercio o de la plataforma; externo = el de la API key.
  let credential = await loadCredential();
  let environment = input.environment;
  if (environment === null) {
    if (!credential && merchant === null) throw credentialMissing();
    // Comercio sin credencial: se registra igual el intento (fila en error) con un
    // ambiente de marcador; nunca se llama a Wompi.
    environment = credential ? credential.mode : "sandbox";
  }

  const begun = await callRpc<{ link: Record<string, unknown>; replayed: boolean }>(
    deps.rpc,
    "payments_begin_link",
    {
      p_client_id: input.clientId,
      p_idempotency_key: input.idempotencyKey,
      p_request_hash: requestHash,
      p_request: request,
      p_environment: environment,
      p_created_by: input.createdBy,
      p_merchant_tenant_id: merchant,
    },
    { PY409: "idempotency_key_reused" },
  );
  const link = begun.link;
  const linkId = String(link.id);

  if (begun.replayed) {
    if (link.status === "creating") {
      throw new ApiError(409, "request_in_progress", "Una petición anterior con esta Idempotency-Key aún está en proceso.", { "Retry-After": "5" });
    }
    return { link, replayed: true };
  }

  const failLink = async (detail: string) => {
    try {
      await callRpc(deps.rpc, "payments_fail_link", { p_link_id: linkId, p_detail: redact(detail, 300) });
    } catch (e) {
      logEvent({ level: "error", event: "fail_link_failed", link_id: linkId, message: e instanceof Error ? e.message : String(e) });
    }
  };

  // Solo en la CREACION: tenant inexistente o inactivo -> falla cerrada.
  if (merchant !== null) {
    let active = false;
    try {
      active = await deps.isMerchantActive(merchant);
    } catch { /* falla cerrada */ }
    if (!active) {
      await failLink("merchant_not_active");
      throw new ApiError(409, "merchant_not_active", "El comercio no existe o no está activo.");
    }
  }
  if (!credential) {
    await failLink(credentialDetail);
    throw credentialMissing();
  }
  if (credential.mode !== environment) {
    await failLink("environment_unavailable");
    throw new ApiError(409, "environment_unavailable", `${merchant === null ? "La plataforma" : "El comercio"} opera en ${credential.mode}; esta clave es de ${environment}.`);
  }
  // Se exigen AMBAS llaves: sin events_key el receptor no podria verificar los
  // eventos y un pago real quedaria sin acreditar (401 permanentes).
  let privateKey: string | null = null;
  let eventsKey: string | null = null;
  try {
    privateKey = await credential.getSecret("private_key");
    eventsKey = await credential.getSecret("events_key");
  } catch {
    privateKey = null;
  }
  if (!privateKey || !eventsKey) {
    await failLink(credentialDetail);
    throw merchant === null
      ? new ApiError(503, "platform_credential_unavailable", "Las llaves de Wompi de la plataforma (privada y de eventos) no están configuradas.")
      : new ApiError(409, "merchant_credential_unavailable", "El comercio no tiene configuradas la llave privada y el secreto de eventos de Wompi.");
  }

  const wompiBody: Record<string, unknown> = {
    name: request.name,
    description: request.description,
    single_use: true,
    collect_shipping: false,
    currency: request.currency,
    amount_in_cents: request.amount_in_cents,
    sku: linkId,
  };
  // Un redirect_url explicito del proyecto SIEMPRE gana. Sin el, Wompi devuelve al
  // comprador a la pagina publica de resultado del SPA (id = el de ESTE link, que
  // payments_begin_link ya inserto antes de llamar a Wompi). El valor por defecto
  // no entra en request_hash ni cambia la idempotencia.
  wompiBody.redirect_url = request.redirect_url ?? paymentReturnUrl(linkId, deps.env.appBaseUrl);
  if (request.expires_at) wompiBody.expires_at = request.expires_at;
  if (request.taxes) wompiBody.taxes = request.taxes;

  let res: Response;
  try {
    res = await postWompi(deps, environment, privateKey, wompiBody);
  } catch (e) {
    // Resultado desconocido: Wompi pudo haber creado el link antes del corte.
    const aborted = e instanceof DOMException && e.name === "AbortError";
    await failLink(aborted ? "provider_timeout_unknown_outcome" : "provider_network_error_unknown_outcome");
    throw new ApiError(502, "provider_unavailable", "No se pudo contactar a Wompi; el resultado es desconocido. Usa una nueva Idempotency-Key.");
  }

  const text = await res.text();
  if (!res.ok) {
    let detail = `provider_http_${res.status}`;
    let messages: unknown = null;
    try {
      messages = (JSON.parse(text) as { error?: { messages?: unknown } })?.error?.messages ?? null;
    } catch { /* cuerpo no JSON */ }
    if (messages) detail += `: ${redact(JSON.stringify(messages), 250)}`;
    await failLink(detail);
    if (res.status >= 400 && res.status < 500) {
      throw new ApiError(422, "provider_rejected", `Wompi rechazó el link${messages ? `: ${redact(JSON.stringify(messages), 250)}` : "."}`);
    }
    throw new ApiError(502, "provider_unavailable", "Wompi no pudo crear el link. Usa una nueva Idempotency-Key.");
  }

  let wompiId: string | null = null;
  try {
    const id = (JSON.parse(text) as { data?: { id?: unknown } })?.data?.id;
    wompiId = typeof id === "string" && id.length > 0 ? id : null;
  } catch { /* se maneja abajo */ }
  if (!wompiId) {
    await failLink("provider_response_without_id");
    throw new ApiError(502, "provider_unavailable", "Respuesta inesperada de Wompi. Usa una nueva Idempotency-Key.");
  }

  const checkoutUrl = wompiAdapter.checkoutUrlFor(wompiId);
  try {
    const attached = await callRpc<Record<string, unknown>>(deps.rpc, "payments_attach_wompi_link", {
      p_link_id: linkId,
      p_wompi_link_id: wompiId,
      p_checkout_url: checkoutUrl,
    });
    return { link: attached, replayed: false };
  } catch (e) {
    // El link YA existe en Wompi: se loguea el par para reconciliar a mano.
    logEvent({ level: "critical", event: "attach_failed_after_provider_create", link_id: linkId, wompi_link_id: wompiId });
    throw e;
  }
}

export async function getLink(
  deps: Deps,
  clientId: string,
  opts: { id?: string | null; externalReference?: string | null },
): Promise<Record<string, unknown>> {
  const link = await callRpc<Record<string, unknown>>(deps.rpc, "payments_get_link", {
    p_client_id: clientId,
    p_id: opts.id ?? null,
    p_external_reference: opts.externalReference ?? null,
  });
  return link;
}
