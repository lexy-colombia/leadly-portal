// Router fino de payments-api. Sin dependencia de Deno.serve para poder
// probarlo con Request/Response directos.
import { ApiError, callRpc, errorResponse, jsonResponse, newRequestId, sanitizeRequestId } from "./errors.ts";
import { authenticateClient } from "./apiKeys.ts";
import { timingSafeEqual } from "./hmac.ts";
import { ADMIN_CORS_HEADERS, handleAdmin } from "./adminRoutes.ts";
import { handleWompiEvent } from "./eventsReceiver.ts";
import { dispatchDue } from "./deliveries.ts";
import { getPublicLinkStatus } from "./publicStatus.ts";
import { createPaymentLink, getLink, isUuid, projectLink, validateIdempotencyKey, validateLinkRequest } from "./wompiLinks.ts";
import type { Deps } from "./types.ts";

/** Segmentos de ruta tras el nombre de la función (acepta con o sin el prefijo /payments-api). */
function pathSegments(pathname: string): string[] {
  const parts = pathname.split("/").filter(Boolean);
  const i = parts.indexOf("payments-api");
  return i >= 0 ? parts.slice(i + 1) : parts;
}

async function readBodyJson(req: Request): Promise<unknown> {
  const text = await req.text();
  if (text.length > 64 * 1024) throw new ApiError(413, "payload_too_large", "Cuerpo demasiado grande.");
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, "invalid_json", "El cuerpo no es JSON válido.");
  }
}

/** CORS de la ruta publica de estado: abierto, SOLO lectura (GET/OPTIONS), sin
 * credenciales ni headers de autorizacion. */
export const PUBLIC_CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-request-id",
  "Access-Control-Max-Age": "86400",
};

export function createHandler(deps: Deps): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const requestId = sanitizeRequestId(req.headers.get("x-request-id")) ?? newRequestId();
    const url = new URL(req.url);
    const segs = pathSegments(url.pathname);
    const area = segs[0];
    const isAdmin = area === "admin";
    // /v1/public/** : lectura publica sin autenticacion (pagina de retorno del SPA).
    const isPublic = area === "v1" && segs[1] === "public";
    const cors = isAdmin ? ADMIN_CORS_HEADERS : isPublic ? PUBLIC_CORS_HEADERS : {};
    try {
      if (req.method === "OPTIONS") {
        if (isAdmin || isPublic) return new Response(null, { status: 204, headers: { ...cors, "X-Request-Id": requestId } });
        throw new ApiError(405, "method_not_allowed", "Método no permitido.");
      }

      // ---- admin
      if (isAdmin) {
        const r = await handleAdmin(deps, req, segs.slice(1), url);
        return jsonResponse(r.body, r.status, requestId, cors);
      }

      // ---- internal (cron)
      if (area === "internal") {
        if (req.method !== "POST") throw new ApiError(405, "method_not_allowed", "Método no permitido.");
        const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
        const expected = deps.env.cronSecret;
        const ok = !!expected && token.length > 0 && (await timingSafeEqual(token, expected));
        if (!ok) throw new ApiError(401, "unauthorized", "No autorizado.");
        if (segs[1] === "dispatch") {
          const r = await dispatchDue(deps, 20);
          return jsonResponse(r, 200, requestId);
        }
        if (segs[1] === "redact") {
          const r = await callRpc<unknown>(deps.rpc, "payments_redact_events", {});
          return jsonResponse(r ?? { redacted: 0 }, 200, requestId);
        }
        throw new ApiError(404, "not_found", "Ruta no encontrada.");
      }

      // ---- v1
      if (area === "v1") {
        const sub = segs[1];
        if (sub === "health" && req.method === "GET") {
          return jsonResponse({ status: "ok" }, 200, requestId);
        }
        if (sub === "events" && segs[2] === "wompi") {
          if (req.method !== "POST") throw new ApiError(405, "method_not_allowed", "Método no permitido.");
          return await handleWompiEvent(deps, req, requestId);
        }
        if (sub === "public") {
          // GET /v1/public/payment-links/{id}/status -- unica ruta publica.
          if (segs[2] === "payment-links" && segs.length === 5 && segs[4] === "status") {
            if (req.method !== "GET") throw new ApiError(405, "method_not_allowed", "Método no permitido.");
            const body = await getPublicLinkStatus(deps, segs[3]);
            return jsonResponse(body, 200, requestId, { ...cors, "Cache-Control": "no-store" });
          }
          throw new ApiError(404, "not_found", "Ruta no encontrada.");
        }
        if (sub === "payment-links") {
          const client = await authenticateClient(deps.rpc, req.headers.get("authorization"));
          const linkId = segs[2];
          if (!linkId && req.method === "POST") {
            const idem = validateIdempotencyKey(req.headers.get("idempotency-key"));
            const request = validateLinkRequest(await readBodyJson(req), deps.now());
            const res = await createPaymentLink(deps, {
              clientId: client.id,
              createdBy: null,
              environment: client.environment,
              idempotencyKey: idem,
              request,
            });
            return jsonResponse(projectLink(res.link), res.replayed ? 200 : 201, requestId, res.replayed ? { "Idempotent-Replayed": "true" } : {});
          }
          if (!linkId && req.method === "GET") {
            const ext = url.searchParams.get("external_reference");
            if (!ext) throw new ApiError(422, "missing_filter", "Indica external_reference.");
            const link = await getLink(deps, client.id, { externalReference: ext });
            return jsonResponse(projectLink(link), 200, requestId);
          }
          if (linkId && req.method === "GET") {
            if (!isUuid(linkId)) throw new ApiError(404, "not_found", "Recurso no encontrado.");
            const link = await getLink(deps, client.id, { id: linkId });
            return jsonResponse(projectLink(link), 200, requestId);
          }
          throw new ApiError(405, "method_not_allowed", "Método no permitido.");
        }
      }
      throw new ApiError(404, "not_found", "Ruta no encontrada.");
    } catch (e) {
      return errorResponse(e, requestId, cors);
    }
  };
}
