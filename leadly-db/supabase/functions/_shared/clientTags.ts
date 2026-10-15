// Escritura de la etiqueta "no contactar" en clients.tags.
//
// SEGURIDAD: clients.tags se LEE para autorizar (la etiqueta "administrador"
// habilita herramientas de administración, ver isAdministratorContact en
// aiTools.ts). Por eso NINGUNA herramienta de IA puede escribir un nombre de
// etiqueta que venga del modelo: la única escritura permitida es esta constante
// del servidor, sin parámetro de texto.

/** Etiqueta literal que usan las campañas para excluir al contacto. */
export const DO_NOT_CONTACT_TAG = "no contactar";

/** Devuelve las tags con DO_NOT_CONTACT_TAG agregada (sin duplicar, sin tocar el resto). */
export function withDoNotContactTag(current: unknown): { tags: string[]; added: boolean } {
  const tags = Array.isArray(current) ? current.map((t) => String(t)) : [];
  const present = tags.some((t) => t.trim().toLowerCase() === DO_NOT_CONTACT_TAG);
  return present ? { tags, added: false } : { tags: [...tags, DO_NOT_CONTACT_TAG], added: true };
}

/** Marca al contacto (de ESTE tenant, no borrado) como "no contactar". Idempotente. */
// deno-lint-ignore no-explicit-any
export async function markClientDoNotContact(adminClient: any, tenantId: string, contactId: string): Promise<{ tags: string[]; added: boolean }> {
  const { data, error } = await adminClient
    .from("clients")
    .select("tags")
    .eq("id", contactId)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("No se encontró el contacto de esta conversación.");
  const next = withDoNotContactTag(data.tags);
  if (!next.added) return next;
  const { error: updError } = await adminClient
    .from("clients")
    .update({ tags: next.tags })
    .eq("id", contactId)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null);
  if (updError) throw new Error(updError.message);
  return next;
}

const PROFILE_FIELDS = ["full_name", "document_type", "document_number", "email"] as const;
const PROFILE_COLUMNS = "full_name, document_type, document_number, email";

/** Implementación de la herramienta update_client_profile (contacto = el de la conversación,
 * inyectado por el servidor). Solo lee de `parameters` los 4 campos de texto y el booleano
 * literal `do_not_contact === true`; cualquier otra clave se ignora. */
// deno-lint-ignore no-explicit-any
export async function updateClientProfile(adminClient: any, tenantId: string, contactId: string, parameters: Record<string, unknown>) {
  const updates: Record<string, string> = {};
  for (const field of PROFILE_FIELDS) {
    const v = parameters[field];
    if (typeof v === "string" && v.trim()) updates[field] = v.trim();
  }
  const doNotContact = parameters.do_not_contact === true;
  const hasUpdates = Object.keys(updates).length > 0;
  if (!hasUpdates && !doNotContact) throw new Error("No se recibió ningún campo para actualizar.");

  const table = adminClient.from("clients");
  const { data, error } = hasUpdates
    ? await table.update(updates).eq("id", contactId).eq("tenant_id", tenantId).select(PROFILE_COLUMNS).single()
    : await table.select(PROFILE_COLUMNS).eq("id", contactId).eq("tenant_id", tenantId).single();
  if (error) throw new Error(error.message);
  if (doNotContact) {
    await markClientDoNotContact(adminClient, tenantId, contactId);
    return { updated: true, ...data, do_not_contact: true };
  }
  return { updated: true, ...data };
}
