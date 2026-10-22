// Arranque UNICO del cliente interno del servicio de pagos (kind='internal'): el
// "cliente" con el que los creadores internos de Leadly (pedido, tienda, IA, factura de
// plataforma) crean links en proceso, y cuyo callback_url/secreto de firma usa el aviso
// firmado hacia payments-internal.
//
// Uso (en TU terminal; el secreto no pasa por ningun chat):
//   SUPABASE_URL=https://kkdtrkfcnyvuefazndnj.supabase.co \
//   SUPABASE_SERVICE_ROLE_KEY=... \
//   deno run -A leadly-db/scripts/create_internal_payments_client.ts
//
// Que hace: genera una API key y un signing secret con los helpers del servicio, guarda
// el secreto de firma en el Vault (payments_store_secret), crea el cliente
// (payments_admin_create_client, kind='internal', callback_url = .../payments-internal),
// DESCARTA la API key (no se imprime ni se guarda: el cliente interno no la usa; los
// creadores van en proceso) e imprime SOLO el id del cliente. El secreto de firma nunca
// sale del Vault: payments-internal lo lee de ahi.
// Idempotente: si ya existe un cliente interno con ese nombre, no crea otro y lo dice.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { generateApiKey, generateSigningSecret } from "../supabase/functions/_shared/payments-service/apiKeys.ts";

export const INTERNAL_CLIENT_NAME = "Leadly (interno)";
const PROJECT_REF_RE = /^https:\/\/([a-z0-9]+)\.supabase\.co\/?$/;

interface RpcLike {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }>;
}

export type BootstrapResult =
  | { created: true; clientId: string }
  | { created: false; clientId: string; note: string; usable: boolean };

/** Nucleo testeable: sin env, sin consola. Nunca devuelve ni registra la API key ni el secreto. */
export async function bootstrapInternalClient(rpc: RpcLike, supabaseUrl: string, name = INTERNAL_CLIENT_NAME): Promise<BootstrapResult> {
  if (!PROJECT_REF_RE.test(supabaseUrl)) throw new Error("SUPABASE_URL debe ser https://<ref>.supabase.co");
  const callbackUrl = `${supabaseUrl.replace(/\/$/, "")}/functions/v1/payments-internal`;

  const list = await rpc.rpc("payments_admin_list_clients", {});
  if (list.error) throw new Error(`No se pudo listar los clientes (${list.error.code ?? "error"}): ${String(list.error.message ?? "").slice(0, 160)}`);
  const rows = Array.isArray(list.data) ? list.data as Array<Record<string, unknown>> : [];
  const existing = rows.find((c) => c.name === name);
  if (existing) {
    const isInternal = existing.kind === "internal";
    const isActive = !existing.revoked_at && existing.status === "active";
    const state = !isInternal
      ? `existe un cliente con ese nombre pero kind=${String(existing.kind)}: NO es el interno, revisalo`
      : !isActive
      ? "el cliente interno existe pero esta suspendido o revocado: reactivalo en lugar de crear otro"
      : "ya existia; no se creo otro";
    return { created: false, clientId: String(existing.id), note: state, usable: isInternal && isActive };
  }

  const key = await generateApiKey("sandbox"); // se descarta: solo hace falta el hash para la columna
  const signingSecret = generateSigningSecret();
  const secretName = `payments/${crypto.randomUUID()}/signing`;
  const stored = await rpc.rpc("payments_store_secret", { p_name: secretName, p_value: signingSecret });
  if (stored.error) throw new Error(`No se pudo guardar el secreto de firma (${stored.error.code ?? "error"}): ${String(stored.error.message ?? "").slice(0, 160)}`);
  const created = await rpc.rpc("payments_admin_create_client", {
    p_name: name,
    p_callback_url: callbackUrl,
    p_key_hash: key.keyHash,
    p_key_prefix: key.keyPrefix,
    p_signing_secret_name: secretName,
    p_created_by: null,
    p_kind: "internal",
  });
  if (created.error) {
    if (created.error.code === "PY409") {
      // Carrera con otra ejecucion: ya existe; se reporta como existente.
      const again = await rpc.rpc("payments_admin_list_clients", {});
      const row = (Array.isArray(again.data) ? again.data as Array<Record<string, unknown>> : []).find((c) => c.name === name);
      if (row) return { created: false, clientId: String(row.id), note: "ya existia; no se creo otro", usable: true };
    }
    throw new Error(`No se pudo crear el cliente (${created.error.code ?? "error"}): ${String(created.error.message ?? "").slice(0, 160)}`);
  }
  const id = (created.data as { id?: unknown } | null)?.id;
  if (typeof id !== "string") throw new Error("Respuesta inesperada al crear el cliente.");
  return { created: true, clientId: id };
}

/** Salida y codigo de salida del script (puro, testeable). Un cliente no usable NO imprime el comando de secretos. */
export function renderOutcome(r: BootstrapResult, ref: string): { code: number; out: string[]; err: string[] } {
  if (!r.created && !r.usable) {
    return { code: 2, out: [], err: [`PROBLEMA: ${r.note}. No uses el id ${r.clientId} como cliente interno hasta resolverlo; no se imprime el comando de secretos.`] };
  }
  return {
    code: 0,
    err: [],
    out: [
      r.created ? "Cliente interno CREADO." : `Cliente interno: ${r.note}.`,
      `client id: ${r.clientId}`,
      `Siguiente paso (secreto de funcion, el id NO es secreto):\n  supabase secrets set PAYMENTS_INTERNAL_CLIENT_ID=${r.clientId} --project-ref ${ref}`,
    ],
  };
}


/** Diagnostico LOCAL de la clave (sin red, sin imprimirla): devuelve un problema legible o null. */
export function diagnoseServiceKey(key: string): string | null {
  const k = key.trim();
  if (k.startsWith("sb_secret_")) return null;
  if (k.startsWith("sb_publishable_")) return "Esa es la clave PUBLICA (publishable). Hace falta la clave service_role / secret.";
  const parts = k.split(".");
  if (parts.length !== 3) return "La clave no tiene el formato de una clave de Supabase (puede ser el texto de ejemplo en vez de la clave real).";
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "=")));
    if (claims.role && claims.role !== "service_role") {
      return `Esa clave es de rol '${claims.role}', no 'service_role'. Hace falta la clave service_role (Project Settings -> API).`;
    }
    return null;
  } catch {
    return "No se pudo leer la clave: no parece una clave de Supabase valida.";
  }
}

if (import.meta.main) {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    console.error("Faltan SUPABASE_URL y/o SUPABASE_SERVICE_ROLE_KEY en el entorno.");
    Deno.exit(1);
  }
  const keyProblem = diagnoseServiceKey(key);
  if (keyProblem) {
    console.error(keyProblem);
    Deno.exit(1);
  }
  try {
    const admin = createClient(url, key, { auth: { persistSession: false } });
    const r = await bootstrapInternalClient(admin as unknown as RpcLike, url);
    const o = renderOutcome(r, PROJECT_REF_RE.exec(url)?.[1] ?? "<ref>");
    o.err.forEach((l) => console.error(l));
    o.out.forEach((l) => console.log(l));
    if (o.code !== 0) Deno.exit(o.code);
  } catch (e) {
    console.error(e instanceof Error ? e.message : "Error inesperado.");
    Deno.exit(1);
  }
}
