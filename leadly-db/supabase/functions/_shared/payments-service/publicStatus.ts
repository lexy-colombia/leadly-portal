// Ruta PUBLICA y minima de estado de un cobro, para la pagina de retorno del SPA.
// GET /v1/public/payment-links/{id}/status  (sin autenticacion).
//
// Contrato EXACTO de la respuesta (nada mas, ver publicStatus_test.ts):
//   { "status": "paid"|"pending"|"expired"|"cancelled"|"voided"|"error"|"unknown",
//     "last_attempt": "APPROVED"|"DECLINED"|"VOIDED"|"ERROR"|null,
//     "updated_at": "<iso>|null" }
// Sin montos, referencias, nombres, correos, ids de proveedor ni tenant. Un id
// inexistente o mal formado responde 200 con el MISMO cuerpo {status:"unknown"}:
// no es un oraculo de existencia.
import { callRpc } from "./errors.ts";
import { isUuid } from "./wompiLinks.ts";
import type { Deps, PublicLinkStatus } from "./types.ts";

export interface PublicStatusBody {
  status: PublicLinkStatus;
  last_attempt: "APPROVED" | "DECLINED" | "VOIDED" | "ERROR" | null;
  updated_at: string | null;
}

export const UNKNOWN_STATUS: PublicStatusBody = { status: "unknown", last_attempt: null, updated_at: null };

const ATTEMPTS = new Set(["APPROVED", "DECLINED", "VOIDED", "ERROR"]);
const NATIVE_STATUS: Record<string, PublicLinkStatus> = {
  creating: "pending", pending: "pending", paid: "paid", voided: "voided",
  expired: "expired", cancelled: "cancelled", error: "error",
};

function iso(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

export async function getPublicLinkStatus(deps: Deps, id: string): Promise<PublicStatusBody> {
  if (!isUuid(id)) return { ...UNKNOWN_STATUS };
  const row = await callRpc<{ found?: boolean; status?: string | null; last_attempt?: string | null; updated_at?: string | null } | null>(
    deps.rpc,
    "payments_public_link_status",
    { p_id: id.toLowerCase() },
  );
  const attempt = row && typeof row.last_attempt === "string" && ATTEMPTS.has(row.last_attempt)
    ? (row.last_attempt as PublicStatusBody["last_attempt"])
    : null;

  if (!row?.found) return { ...UNKNOWN_STATUS };
  const status = NATIVE_STATUS[String(row.status)] ?? "unknown";
  return { status, last_attempt: attempt, updated_at: iso(row.updated_at) };
}
