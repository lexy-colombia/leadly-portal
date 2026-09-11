// Avisa por WhatsApp al equipo comercial cuando la IA registra un interesado
// nuevo, para que nadie tenga que estar mirando la plataforma todo el día
// esperando a que caiga un lead (pedido explícito del usuario, 2026-09-11:
// "con eso no quedo ciego ni tengo que estar revisando la plataforma todo el
// tiempo").
//
// Se dispara sobre `opportunities`, no sobre la conversación, porque crear
// una oportunidad es exactamente lo que Aurora hace cuando detecta interés
// real (ver la sección 26 del prompt) -- y como es un trigger sobre la
// tabla, también cubre las que crea un agente humano a mano.
//
// ⚠️ Por qué un cron cada 5 minutos y no un trigger inmediato: Aurora puede
// crear la oportunidad con "Sector: por confirmar" y completarla uno o dos
// turnos después, cuando el cliente contesta. Avisar al instante mandaría
// una alerta a medio llenar, que es justo lo que no sirve. El colchón de
// GRACE_MINUTES deja que la descripción termine de armarse antes de salir.
//
// Misma autorización CRON_REMINDER_SECRET que send-task-reminders /
// run-campaigns (ver el comentario de cabecera de esas funciones).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { json } from "../_shared/cors.ts";
import { sendWhatsappTemplate } from "../_shared/whatsapp.ts";

/** Nombre de la plantilla aprobada en Meta. Una plantilla es obligatoria:
 * este aviso sale fuera de la ventana de 24 horas de Meta (nadie le escribió
 * al negocio), así que un texto libre no se entregaría nunca.
 *
 * ⚠️ El nombre cambió una vez (2026-09-11) y no se puede volver atrás: la
 * primera versión se llamaba `lexy_lead_interesado` y hubo que borrarla
 * porque Meta la había RECLASIFICADO de UTILITY a MARKETING por su
 * redacción, y la categoría de una plantilla no se puede editar mientras
 * está en revisión. Meta reserva el nombre de una plantilla borrada por
 * semanas, así que la versión nueva necesitó un nombre distinto. */
const TEMPLATE_NAME = "lexy_solicitud_contacto";
const TEMPLATE_LANGUAGE = "es";
const GRACE_MINUTES = 3;
const GRAPH_API_VERSION = "v21.0";

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!isCronCaller(req.headers.get("Authorization") ?? "")) return json({ error: "Forbidden" }, 403);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const adminClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const cutoff = new Date(Date.now() - GRACE_MINUTES * 60_000).toISOString();
  const { data: opportunities, error } = await adminClient
    .from("opportunities")
    .select("id, tenant_id, title, description, contact_id, created_at, clients!contact_id(full_name, phone, phone_prefix)")
    .is("lead_alert_sent_at", null)
    .is("deleted_at", null)
    .lt("created_at", cutoff)
    .order("created_at")
    .limit(20);
  if (error) {
    console.error("[notify-sales-lead] no se pudieron leer las oportunidades", error);
    return json({ error: "Query failed" }, 500);
  }

  let sent = 0;
  let skipped = 0;
  // Una consulta por tenant, no por oportunidad -- varias oportunidades del
  // mismo tenant en el mismo barrido comparten destino, línea y plantilla.
  const tenantCache = new Map<string, TenantTarget | null>();

  for (const opportunity of opportunities ?? []) {
    let target = tenantCache.get(opportunity.tenant_id);
    if (target === undefined) {
      target = await resolveTenantTarget(adminClient, opportunity.tenant_id);
      tenantCache.set(opportunity.tenant_id, target);
    }
    // Tenant sin número configurado, sin línea activa o sin la plantilla
    // aprobada: no se marca la oportunidad, para que el aviso salga solo en
    // cuanto se configure lo que falta en vez de perderse para siempre.
    if (!target) {
      skipped++;
      continue;
    }

    // deno-lint-ignore no-explicit-any
    const contact = opportunity.clients as any;
    const fields = parseOpportunityFields(opportunity.description ?? "");
    const variables = [
      contact?.full_name?.trim() || "Sin nombre",
      formatPhone(contact),
      fields.sector || "No especificado",
      fields.needs || opportunity.title || "No especificado",
    ];

    const result = await sendWhatsappTemplate(
      target.phoneNumberId,
      target.accessToken,
      target.recipient,
      TEMPLATE_NAME,
      TEMPLATE_LANGUAGE,
      [{ type: "body", parameters: variables.map((text) => ({ type: "text", text: oneLine(text) })) }],
    );

    if (!result.ok) {
      // No se marca: un fallo puntual de Meta no debe consumir el único
      // aviso que esta oportunidad va a recibir. Se reintenta al próximo
      // barrido.
      console.error(`[notify-sales-lead] falló el aviso de ${opportunity.id}`, result.errorMessage);
      skipped++;
      continue;
    }

    await adminClient.from("opportunities").update({ lead_alert_sent_at: new Date().toISOString() }).eq("id", opportunity.id);
    sent++;
  }

  return json({ scanned: opportunities?.length ?? 0, sent, skipped }, 200);
});

interface TenantTarget {
  recipient: string;
  phoneNumberId: string;
  accessToken: string;
}

// deno-lint-ignore no-explicit-any
async function resolveTenantTarget(adminClient: any, tenantId: string): Promise<TenantTarget | null> {
  const { data: tenant } = await adminClient
    .from("tenants")
    .select("sales_notification_phone")
    .eq("id", tenantId)
    .maybeSingle();
  const recipient = (tenant?.sales_notification_phone ?? "").replace(/\D/g, "");
  if (!recipient) return null; // el tenant no pidió el aviso -- es opt-in, no un default.

  const { data: line } = await adminClient
    .from("whatsapp_lines")
    .select("id, phone_number_id")
    .eq("tenant_id", tenantId)
    .eq("status", "active")
    .limit(1)
    .maybeSingle();
  if (!line) return null;

  const approved = await ensureTemplateApproved(adminClient, tenantId, line.id);
  if (!approved) return null;

  const { data: accessToken } = await adminClient.rpc("get_whatsapp_line_access_token", { p_line_id: line.id });
  if (!accessToken) return null;

  return { recipient, phoneNumberId: line.phone_number_id, accessToken };
}

/** Meta tarda en aprobar una plantilla nueva, y nuestra tabla guarda el
 * estado del momento en que se creó. Si sigue en PENDING se le vuelve a
 * preguntar a Meta acá mismo: así el aviso empieza a salir solo el día que
 * la aprueban, sin que nadie tenga que acordarse de sincronizar nada. */
// deno-lint-ignore no-explicit-any
async function ensureTemplateApproved(adminClient: any, tenantId: string, lineId: string): Promise<boolean> {
  const { data: template } = await adminClient
    .from("whatsapp_message_templates")
    .select("id, status, business_account_id")
    .eq("tenant_id", tenantId)
    .eq("name", TEMPLATE_NAME)
    .is("deleted_at", null)
    .maybeSingle();
  if (!template) return false;
  if (template.status === "APPROVED") return true;
  if (template.status === "REJECTED") return false;

  const { data: accessToken } = await adminClient.rpc("get_whatsapp_line_access_token", { p_line_id: lineId });
  if (!accessToken) return false;

  try {
    const resp = await fetch(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${template.business_account_id}/message_templates?fields=name,status&name=${TEMPLATE_NAME}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    const body = await resp.json();
    const status = body?.data?.find((t: { name?: string }) => t.name === TEMPLATE_NAME)?.status;
    if (!status || status === template.status) return false;
    await adminClient.from("whatsapp_message_templates").update({ status }).eq("id", template.id);
    return status === "APPROVED";
  } catch (err) {
    console.error("[notify-sales-lead] no se pudo consultar el estado de la plantilla", err);
    return false;
  }
}

/** La descripción de la oportunidad la escribe Aurora con el formato fijo de
 * la sección 26 del prompt (`Sector:` / `Necesita:` / `Solución:`). Se lee
 * con tolerancia: si el modelo se salió del formato, se devuelve vacío y el
 * aviso sale con "No especificado" en vez de romperse. */
function parseOpportunityFields(description: string): { sector: string; needs: string } {
  const pick = (label: string) => description.match(new RegExp(`^\\s*${label}\\s*:\\s*(.+)$`, "im"))?.[1]?.trim() ?? "";
  return { sector: pick("Sector"), needs: pick("Necesita") };
}

// deno-lint-ignore no-explicit-any
function formatPhone(contact: any): string {
  const prefix = (contact?.phone_prefix ?? "").toString().replace(/\D/g, "");
  const number = (contact?.phone ?? "").toString().replace(/\D/g, "");
  if (!number) return "Sin teléfono";
  return prefix && !number.startsWith(prefix) ? `+${prefix} ${number}` : `+${number}`;
}

/** Meta rechaza un parámetro de plantilla que traiga saltos de línea,
 * tabulaciones o más de 4 espacios seguidos -- la descripción de una
 * oportunidad es texto multilínea, así que se aplana antes de mandarla. */
function oneLine(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > 300 ? `${flat.slice(0, 297)}...` : flat;
}

function isCronCaller(authHeader: string): boolean {
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const expected = Deno.env.get("CRON_REMINDER_SECRET");
  return !!expected && token === expected;
}
