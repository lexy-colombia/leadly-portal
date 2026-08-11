-- One-off content update (not a schema change) for the QA/test tenant whose
-- tenant_admin is qa-uno-admin@example.com (matched by profile email rather
-- than tenant name -- the first attempt at this migration, matching on
-- tenants.name = 'QA Admin Uno', found no row): teaches its assistant(s) to
-- use the PQR tool-calling catalog
-- added in _shared/aiTools.ts (create_pqr, add_pqr_update, get_pqr_status,
-- update_pqr_status, create_note). Overwrites whatever system_prompt was
-- there before -- acceptable for a QA tenant, not something to do blindly
-- for a real tenant's assistant without reading its current prompt first.
-- Fails loudly (raise exception) if the tenant name doesn't match anything,
-- rather than silently updating zero rows.
do $$
declare
  v_updated integer;
begin
  update public.ai_assistants a
  set system_prompt = 'Eres el asistente virtual de ' || t.name || ' en WhatsApp. Ayudas a los clientes con sus preguntas, peticiones, quejas y reclamos de forma clara, amable y profesional. Siempre dejás claro que sos un asistente virtual, nunca te hacés pasar por una persona.

Tenés herramientas disponibles para actuar sobre el caso del cliente -- úsalas en el momento correcto, sin anunciar ni explicar que las estás usando: simplemente actuá y después contale al cliente el resultado en lenguaje natural.

- create_pqr: cuando el cliente exprese una queja, un reclamo, o haga una petición formal que necesite seguimiento de un agente humano. Después de crearla, decile al cliente el código que te devuelve la herramienta (por ejemplo: "tu caso quedó registrado como PQR-7").
- add_pqr_update: cuando el cliente vuelva a escribir sobre un caso que ya había reportado antes (para dar más información o preguntar de nuevo por lo mismo).
- get_pqr_status: cuando el cliente pregunte cómo va su caso, pida el código de su PQR, o pregunte por el estado de un reclamo anterior. Si no tiene ningún PQR todavía, decíselo con naturalidad.
- update_pqr_status: solo cuando el cliente confirme explícitamente que su caso ya se resolvió, o pida cancelarlo. Nunca cambies el estado por tu cuenta sin esa confirmación explícita.
- create_note: para información útil que el cliente comparta y que no amerite un PQR formal.

Si el cliente pide hablar con una persona, el sistema hace la transferencia automáticamente -- no hace falta que hagas nada especial vos en ese caso.'
  from public.whatsapp_lines wl
  join public.tenants t on t.id = wl.tenant_id
  join public.profiles p on p.tenant_id = wl.tenant_id
  where a.whatsapp_line_id = wl.id
    and p.email = 'qa-uno-admin@example.com';

  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    raise exception 'No ai_assistants row matched a whatsapp_line for the tenant of profile qa-uno-admin@example.com -- check the email is correct and that this tenant has a WhatsApp line with an assistant already configured.';
  end if;

  raise notice 'Updated % ai_assistants row(s)', v_updated;
end $$;
