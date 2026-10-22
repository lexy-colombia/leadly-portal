// Errores de la API: { error: { code, message, request_id } }. Nunca incluye
// secretos ni el mensaje crudo de la base.
import type { RpcClient } from "./types.ts";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public headers: Record<string, string> = {}) {
    super(message);
  }
}

const SECRET_PATTERNS: RegExp[] = [
  /lxy_pay_(?:test|live)_[A-Za-z0-9_-]{8}_[A-Za-z0-9_-]{20,}/g,
  /lxy_whsec_[A-Za-z0-9_-]{20,}/g,
  /\b(?:prv|pub)_(?:test|prod)_[A-Za-z0-9]+/g,
  /\b(?:test|prod)_(?:events|integrity)_[A-Za-z0-9]+/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g,
];

/** Quita de un texto cualquier cosa que parezca una credencial. */
export function redact(text: string, max = 300): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[redacted]");
  return out.length > max ? `${out.slice(0, max)}...` : out;
}

export function newRequestId(): string {
  return crypto.randomUUID();
}

export function sanitizeRequestId(raw: string | null): string | null {
  return raw && /^[A-Za-z0-9._-]{1,64}$/.test(raw) ? raw : null;
}

export function errorBody(code: string, message: string, requestId: string) {
  return { error: { code, message, request_id: requestId } };
}

export function jsonResponse(
  body: unknown,
  status: number,
  requestId: string,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "X-Request-Id": requestId, ...extraHeaders },
  });
}

export function errorResponse(err: unknown, requestId: string, extraHeaders: Record<string, string> = {}): Response {
  if (err instanceof ApiError) {
    return jsonResponse(errorBody(err.code, err.message, requestId), err.status, requestId, { ...extraHeaders, ...err.headers });
  }
  // Error inesperado: se loguea (sin secretos) y se responde genérico.
  const msg = err instanceof Error ? err.message : String(err);
  console.error(JSON.stringify({ level: "error", request_id: requestId, event: "unhandled", message: redact(msg) }));
  return jsonResponse(errorBody("internal_error", "Error interno.", requestId), 500, requestId, extraHeaders);
}

/** Mapea el SQLSTATE de las funciones payments_* (spec §2) a un ApiError. */
export function mapRpcError(fn: string, error: { code?: string; message: string }, overrides: Partial<Record<string, string>> = {}): ApiError {
  const clean = redact(error.message ?? "", 200);
  switch (error.code) {
    case "PY404":
      return new ApiError(404, overrides.PY404 ?? "not_found", "Recurso no encontrado.");
    case "PY409":
      return new ApiError(409, overrides.PY409 ?? "conflict", clean || "Conflicto con el estado actual.");
    case "PY422":
      return new ApiError(422, overrides.PY422 ?? "invalid_request", clean || "Dato inválido.");
    case "PY423":
      return new ApiError(409, overrides.PY423 ?? "invalid_state", clean || "Estado no permitido para esta operación.");
    case "PY424":
      // payments_begin_link: un proyecto que no es `internal` pidio un comercio.
      return new ApiError(403, overrides.PY424 ?? "merchant_not_allowed", "Este proyecto no puede crear links a nombre de un comercio.");
    default:
      console.error(JSON.stringify({ level: "error", event: "rpc_failed", fn, code: error.code ?? null, message: redact(error.message ?? "", 200) }));
      return new ApiError(500, "internal_error", "Error interno.");
  }
}

/** Llama una función payments_* y lanza ApiError si falla. */
export async function callRpc<T>(
  rpc: RpcClient,
  fn: string,
  args: Record<string, unknown>,
  overrides: Partial<Record<string, string>> = {},
): Promise<T> {
  const { data, error } = await rpc.rpc(fn, args);
  if (error) throw mapRpcError(fn, error, overrides);
  return data as T;
}

export function logEvent(fields: Record<string, unknown>) {
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) safe[k] = typeof v === "string" ? redact(v, 200) : v;
  console.log(JSON.stringify(safe));
}
