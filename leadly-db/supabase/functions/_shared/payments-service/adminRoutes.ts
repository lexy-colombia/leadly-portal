// Rutas /admin (superadmin con JWT de Supabase; NO API key).
import { ApiError, callRpc } from "./errors.ts";
import { generateApiKey, generateSigningSecret } from "./apiKeys.ts";
import { checkCallbackDestination, DestinationError } from "./ssrf.ts";
import { createPaymentLink, isUuid, projectLink, validateIdempotencyKey, validateLinkRequest } from "./wompiLinks.ts";
import type { Deps } from "./types.ts";

/** CORS propio de /admin (no se toca _shared/cors.ts: no lista GET/PATCH y lo
 * usan otras funciones). `*` es aceptable porque la autenticación es un
 * Bearer JWT explícito, sin cookies: ningún origen hereda sesión ambiente. */
export const ADMIN_CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, idempotency-key",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
  "Access-Control-Max-Age": "7200",
};

export interface AdminResult {
  status: number;
  body: unknown;
}

type Row = Record<string, unknown>;

function projectClient(c: Row): Row {
  return {
    id: c.id,
    name: c.name,
    status: c.status,
    key_prefix: c.key_prefix ?? null,
    callback_url: c.callback_url ?? null,
    created_at: c.created_at ?? null,
    revoked_at: c.revoked_at ?? null,
  };
}

async function listClients(deps: Deps): Promise<Row[]> {
  const r = await callRpc<unknown>(deps.rpc, "payments_admin_list_clients", {});
  if (Array.isArray(r)) return r as Row[];
  const items = (r as { items?: unknown } | null)?.items;
  return Array.isArray(items) ? (items as Row[]) : [];
}

async function findClient(deps: Deps, id: string): Promise<Row> {
  const c = (await listClients(deps)).find((x) => x.id === id);
  if (!c) throw new ApiError(404, "not_found", "Proyecto no encontrado.");
  return c;
}

async function requireMode(deps: Deps) {
  const cred = await deps.getPlatformCredential();
  if (!cred) {
    throw new ApiError(409, "platform_credential_missing", "Carga primero la credencial de Wompi de la plataforma.");
  }
  return cred.mode;
}

async function validateCallback(deps: Deps, url: unknown): Promise<string> {
  if (typeof url !== "string") throw new ApiError(422, "invalid_callback_url", "callback_url debe ser texto.");
  try {
    return (await checkCallbackDestination(url, deps.resolveDns)).toString();
  } catch (e) {
    const reason = e instanceof DestinationError ? e.reason : "invalid_url";
    throw new ApiError(422, "invalid_callback_url", `callback_url no permitida (${reason}).`);
  }
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.length > 64 * 1024) throw new ApiError(413, "payload_too_large", "Cuerpo demasiado grande.");
  try {
    const v = JSON.parse(text);
    if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error("x");
    return v as Record<string, unknown>;
  } catch {
    throw new ApiError(400, "invalid_json", "El cuerpo debe ser un objeto JSON.");
  }
}

async function storeSecret(deps: Deps, name: string, value: string) {
  await callRpc(deps.rpc, "payments_store_secret", { p_name: name, p_value: value });
}

export async function handleAdmin(deps: Deps, req: Request, segments: string[], url: URL): Promise<AdminResult> {
  const { userId } = await deps.verifyAdmin(req.headers.get("authorization"));
  const method = req.method;
  const [section, id, action] = segments; // segments sin el prefijo "admin"

  // ---- clients
  if (section === "clients") {
    if (!id && method === "GET") {
      const items = (await listClients(deps)).map(projectClient);
      return { status: 200, body: { items } };
    }
    if (!id && method === "POST") {
      const body = await readJson(req);
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (name.length < 1 || name.length > 80) throw new ApiError(422, "invalid_field", "name debe tener entre 1 y 80 caracteres.");
      for (const k of Object.keys(body)) {
        if (k !== "name" && k !== "callback_url") throw new ApiError(422, "field_not_allowed", `El campo "${k}" no se permite.`);
      }
      const callback = body.callback_url === undefined || body.callback_url === null ? null : await validateCallback(deps, body.callback_url);
      const mode = await requireMode(deps);
      const key = await generateApiKey(mode);
      const signingSecret = generateSigningSecret();
      const secretName = `payments/${crypto.randomUUID()}/signing`;
      // Primero el secreto (un secreto huérfano es inalcanzable; un cliente
      // con nombre de secreto colgante rompería entregas).
      await storeSecret(deps, secretName, signingSecret);
      const client = await callRpc<Row>(deps.rpc, "payments_admin_create_client", {
        p_name: name,
        p_callback_url: callback,
        p_key_hash: key.keyHash,
        p_key_prefix: key.keyPrefix,
        p_signing_secret_name: secretName,
        p_created_by: userId,
      }, { PY409: "client_name_taken" });
      return { status: 201, body: { client: projectClient(client), api_key: key.apiKey, signing_secret: signingSecret } };
    }
    if (isUuid(id) && action === "rotate-key" && method === "POST") {
      await findClient(deps, id);
      const mode = await requireMode(deps);
      const key = await generateApiKey(mode);
      const client = await callRpc<Row>(deps.rpc, "payments_admin_rotate_key", {
        p_id: id,
        p_key_hash: key.keyHash,
        p_key_prefix: key.keyPrefix,
      });
      return { status: 200, body: { client: projectClient(client), api_key: key.apiKey } };
    }
    if (isUuid(id) && !action && method === "PATCH") {
      const body = await readJson(req);
      for (const k of Object.keys(body)) {
        if (k !== "status" && k !== "callback_url") throw new ApiError(422, "field_not_allowed", `El campo "${k}" no se permite.`);
      }
      if (body.status === undefined && body.callback_url === undefined) {
        throw new ApiError(422, "invalid_request", "Envía status y/o callback_url.");
      }
      let client = await findClient(deps, id);
      if (body.status !== undefined) {
        if (body.status !== "active" && body.status !== "suspended") {
          throw new ApiError(422, "invalid_field", 'status debe ser "active" o "suspended".');
        }
        client = await callRpc<Row>(deps.rpc, "payments_admin_set_client_status", { p_id: id, p_status: body.status });
      }
      if (body.callback_url !== undefined) {
        const callback = body.callback_url === null ? null : await validateCallback(deps, body.callback_url);
        let secretName = await callRpc<string | null>(deps.rpc, "payments_read_signing_secret_name", { p_client_id: id });
        let newSecret: string | null = null;
        if (!secretName) {
          secretName = `payments/${crypto.randomUUID()}/signing`;
          newSecret = generateSigningSecret();
          await storeSecret(deps, secretName, newSecret);
        }
        client = await callRpc<Row>(deps.rpc, "payments_admin_set_callback", {
          p_id: id,
          p_callback_url: callback,
          p_signing_secret_name: secretName,
        });
        if (newSecret) return { status: 200, body: { client: projectClient(client), signing_secret: newSecret } };
      }
      return { status: 200, body: { client: projectClient(client) } };
    }
    throw new ApiError(404, "not_found", "Ruta no encontrada.");
  }

  // ---- links
  if (section === "links" && !id) {
    if (method === "GET") {
      const clientId = url.searchParams.get("client_id");
      const status = url.searchParams.get("status");
      const before = url.searchParams.get("before");
      if (clientId && !isUuid(clientId)) throw new ApiError(422, "invalid_field", "client_id inválido.");
      if (status && !["creating", "pending", "paid", "expired", "cancelled", "error"].includes(status)) {
        throw new ApiError(422, "invalid_field", "status inválido.");
      }
      if (before && Number.isNaN(Date.parse(before))) throw new ApiError(422, "invalid_field", "before debe ser ISO 8601.");
      const limitRaw = Number(url.searchParams.get("limit") ?? "50");
      const limit = Number.isInteger(limitRaw) ? Math.min(100, Math.max(1, limitRaw)) : 50;
      const r = await callRpc<{ items?: Row[]; next_before?: string | null }>(deps.rpc, "payments_list_links", {
        p_client_id: clientId || null,
        p_status: status || null,
        p_limit: limit,
        p_before: before || null,
      });
      const rows = r?.items ?? [];
      let names: Map<unknown, unknown> | null = null;
      if (rows.some((l) => l.client_name === undefined)) {
        names = new Map((await listClients(deps)).map((c) => [c.id, c.name]));
      }
      const items = rows.map((l) => ({
        id: l.id,
        client_id: l.client_id,
        client_name: l.client_name ?? names?.get(l.client_id) ?? null,
        external_reference: l.external_reference,
        amount_in_cents: l.amount_in_cents,
        currency: l.currency,
        status: l.status,
        checkout_url: l.checkout_url ?? null,
        environment: l.environment,
        created_at: l.created_at,
        paid_at: l.paid_at ?? null,
      }));
      return { status: 200, body: { items, next_before: r?.next_before ?? null } };
    }
    if (method === "POST") {
      const body = await readJson(req);
      const { client_id: clientId, idempotency_key: idemRaw, ...rest } = body;
      if (!isUuid(clientId)) throw new ApiError(422, "invalid_field", "client_id es obligatorio (uuid).");
      const idem = validateIdempotencyKey(idemRaw);
      const request = validateLinkRequest(rest, deps.now());
      const client = await findClient(deps, clientId);
      if (client.status !== "active") throw new ApiError(409, "client_not_active", "El proyecto no está activo.");
      const res = await createPaymentLink(deps, {
        clientId,
        createdBy: userId,
        environment: null,
        idempotencyKey: idem,
        request,
      });
      return { status: res.replayed ? 200 : 201, body: projectLink(res.link) };
    }
    throw new ApiError(404, "not_found", "Ruta no encontrada.");
  }

  // ---- readiness
  if (section === "readiness" && !id && method === "GET") {
    let configured = false;
    let mode: string | null = null;
    try {
      const cred = await deps.getPlatformCredential();
      if (cred) {
        mode = cred.mode;
        const [pk, ek] = await Promise.all([cred.getSecret("private_key"), cred.getSecret("events_key")]);
        configured = !!pk && !!ek;
      }
    } catch {
      configured = false;
    }
    const clients = await listClients(deps);
    let health: unknown = null;
    try {
      health = await callRpc<unknown>(deps.rpc, "payments_health_summary", {});
    } catch {
      health = null; // no debe romper la tarjeta de conexión
    }
    return {
      status: 200,
      body: {
        platform_credential: { configured, mode },
        events_url: `${deps.env.supabaseUrl}/functions/v1/payments-api/v1/events/wompi`,
        clients_active: clients.filter((c) => c.status === "active").length,
        health,
      },
    };
  }

  throw new ApiError(404, "not_found", "Ruta no encontrada.");
}
