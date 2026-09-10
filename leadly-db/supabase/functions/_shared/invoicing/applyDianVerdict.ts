/** Traduce un `DianTrackStatus` (ver getDianStatus.ts) al veredicto real de
 * la DIAN sobre un documento, y aplica sus efectos sobre la fila
 * correspondiente -- pieza compartida entre el envío síncrono
 * (sendInvoiceToDian.ts/sendCreditNoteToDian.ts, que ahora consulta el
 * estado apenas manda el documento) y el fallback manual
 * (dian-submit/index.ts::handleCheckInvoiceStatus/handleCheckCreditNoteStatus,
 * para cuando el polling síncrono se agotó sin una respuesta concluyente).
 * Antes esta lógica vivía solo en dian-submit/index.ts -- se centraliza acá
 * para que ambos caminos apliquen EXACTAMENTE el mismo efecto sobre el
 * consecutivo (ver abajo), en vez de que el camino manual se quedara con
 * una versión vieja que no lo tocaba.
 *
 * Pedido explícito del usuario 2026-09-09: "si no hay una factura correcta
 * no cambia el tema del consecutivo... la factura real se entiende que
 * funcionó correctamente cuando se generó en la DIAN" -- `next_invoice_number`/
 * `next_credit_note_number` (el puntero a qué número usar la PRÓXIMA vez)
 * solo debe avanzar cuando la DIAN de verdad ACEPTÓ el documento, nunca con
 * el mero acuse de recibido ("sent") ni con un rechazo. El número ya
 * quedó grabado en la fila (invoice_number/credit_note_number, hace falta
 * para construir el XML/CUFE antes de mandar), lo que no debe avanzar es el
 * PUNTERO -- así un intento rechazado libera ese mismo número para el
 * próximo intento real, en vez de quemarlo.
 *
 * ⚠️ 2026-09-10: la ENTREGA del documento al adquiriente por correo
 * (Anexo Técnico numeral 9.3) también cuelga de acá, de la rama
 * `accepted`. Es deliberado y vale la pena justificarlo, porque mezclar un
 * efecto saliente con "escribir el veredicto" es discutible: hay CUATRO
 * caminos por los que una factura o nota crédito puede terminar aceptada
 * (envío síncrono de factura, envío de nota crédito, y los dos "Verificar
 * estado" manuales), y todos convergen exactamente en estas dos funciones.
 * Colgar el envío de cada caller sería reintroducir el mismo problema que
 * ya obligó a centralizar la confirmación de venta en triggers de base de
 * datos el 2026-09-03: tres copias de la misma regla, y la que se olvida
 * de actualizar es la que rompe en producción. `sendDocumentEmail` nunca
 * lanza, así que esto no puede tumbar el registro del veredicto. */
import type { DianTrackStatus } from "./getDianStatus.ts";

export interface DianVerdict {
  outcome: "accepted" | "rejected" | "inconclusive";
  detail: string | null;
}

export function interpretDianStatus(status: DianTrackStatus | null): DianVerdict {
  if (!status || status.isValid === null || status.isValid === undefined) return { outcome: "inconclusive", detail: null };
  if (status.isValid) return { outcome: "accepted", detail: status.statusDescription ?? status.statusMessage ?? null };
  if (isStillValidating(status)) return { outcome: "inconclusive", detail: null };
  const detail = status.errorMessages.length > 0 ? status.errorMessages.join(" -- ") : (status.statusMessage ?? status.statusDescription ?? "Rechazada por la DIAN.");
  return { outcome: "rejected", detail };
}

/** La DIAN responde `IsValid: false` tanto para un rechazo real como
 * mientras el batch todavía se está validando de forma asíncrona -- un
 * estado transitorio conocido de esta misma API (mensajes tipo "Batch en
 * proceso de validación"/"TrackId no encontrado"), no un veredicto sobre el
 * documento. Bug real encontrado en vivo 2026-09-10: una factura de
 * habilitación quedó marcada "rechazada" a los 5 segundos de mandarse --
 * la DIAN ni había alcanzado a procesar el batch, `errorMessages` venía
 * vacío y el único texto era ese aviso de "todavía en proceso" en
 * `statusDescription`. Se exige `errorMessages` vacío para esta detección:
 * un rechazo real de contenido (reglas FAxx) siempre trae al menos un
 * mensaje de error concreto ahí. */
function isStillValidating(status: DianTrackStatus): boolean {
  if (status.errorMessages.length > 0) return false;
  const text = `${status.statusDescription ?? ""} ${status.statusMessage ?? ""}`.toLowerCase();
  return /proceso de validaci|en proceso|trackid no encontrado/.test(text);
}

/** Aplica el veredicto sobre una factura ya enviada -- no hace nada si
 * sigue inconcluso (la fila se deja en 'sent' para reintentar más tarde). */
export async function applyInvoiceVerdict(
  // deno-lint-ignore no-explicit-any
  adminClient: any,
  tenantId: string,
  invoiceId: string,
  invoiceNumber: number,
  verdict: DianVerdict,
): Promise<void> {
  const now = new Date().toISOString();
  if (verdict.outcome === "accepted") {
    await adminClient.from("sales_invoices").update({ status: "accepted", status_detail: verdict.detail, accepted_at: now }).eq("id", invoiceId);
    await bumpNextNumberIfBehind(adminClient, "tenant_dian_profile", "next_invoice_number", tenantId, invoiceNumber);
    // Entrega al adquiriente (Anexo Técnico 9.3) -- ver la nota de arriba
    // sobre por qué este efecto vive acá y no en cada caller.
    await requestDocumentEmail({ invoice_id: invoiceId });
  } else if (verdict.outcome === "rejected") {
    await adminClient.from("sales_invoices").update({ status: "rejected", status_detail: verdict.detail, rejected_at: now }).eq("id", invoiceId);
  }
}

/** Misma idea para una nota crédito. */
export async function applyCreditNoteVerdict(
  // deno-lint-ignore no-explicit-any
  adminClient: any,
  tenantId: string,
  creditNoteId: string,
  creditNoteNumber: number,
  verdict: DianVerdict,
): Promise<void> {
  const now = new Date().toISOString();
  if (verdict.outcome === "accepted") {
    await adminClient.from("sales_credit_notes").update({ status: "accepted", status_detail: verdict.detail, accepted_at: now }).eq("id", creditNoteId);
    await bumpNextNumberIfBehind(adminClient, "tenant_dian_profile", "next_credit_note_number", tenantId, creditNoteNumber);
    await requestDocumentEmail({ credit_note_id: creditNoteId });
  } else if (verdict.outcome === "rejected") {
    await adminClient.from("sales_credit_notes").update({ status: "rejected", status_detail: verdict.detail, rejected_at: now }).eq("id", creditNoteId);
  }
}

/** Dispara la entrega al adquiriente invocando la Edge Function
 * `send-document-email`, en vez de importar ese módulo acá.
 *
 * ⚠️ NO es una preferencia de estilo, es obligatorio: esta pieza la
 * importa dian-submit, que carga `nodeCompatShim.ts` (reemplaza `process`
 * por un objeto mínimo para que pkijs/node-forge no revienten al
 * importarse). pdf-lib, que hace falta para adjuntar la representación
 * gráfica, llama a `process.nextTick`, que ese objeto no tiene -- meter el
 * render de PDF en este grafo de imports rompe el envío con
 * "process.nextTick is not a function" (encontrado en vivo 2026-09-10).
 * Ver el comentario de cabecera de send-document-email/index.ts.
 *
 * Se ESPERA la respuesta a propósito: una Edge Function mata cualquier
 * fetch no esperado al retornar (pitfall ya documentado en CLAUDE.md), así
 * que un fire-and-forget acá no entregaría nada. Nunca lanza -- el
 * veredicto de la DIAN ya quedó escrito y no puede deshacerse porque
 * falle un correo; el detalle del fallo queda en sales_document_emails. */
async function requestDocumentEmail(payload: { invoice_id?: string; credit_note_id?: string }): Promise<void> {
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) return;
    const res = await fetch(`${supabaseUrl}/functions/v1/send-document-email`, {
      method: "POST",
      headers: { Authorization: `Bearer ${serviceRoleKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) console.error(`[applyDianVerdict] entrega por correo no realizada (HTTP ${res.status}):`, (await res.text()).slice(0, 300));
  } catch (err) {
    console.error("[applyDianVerdict] no se pudo invocar la entrega por correo:", err);
  }
}

/** Nunca retrocede el puntero (por si dos verificaciones del mismo intento
 * corren en paralelo, o el manual llega después del síncrono) -- solo lo
 * adelanta hasta documentNumber+1 si todavía no llegó ahí. */
// deno-lint-ignore no-explicit-any
async function bumpNextNumberIfBehind(adminClient: any, table: string, column: string, tenantId: string, documentNumber: number): Promise<void> {
  const { data: row } = await adminClient.from(table).select(column).eq("tenant_id", tenantId).maybeSingle();
  const current = row ? Number(row[column] ?? 0) : 0;
  const nextAfterThis = Number(documentNumber) + 1;
  if (current < nextAfterThis) {
    await adminClient.from(table).update({ [column]: nextAfterThis }).eq("tenant_id", tenantId);
  }
}
