-- Follow-up to the image-attachments feature (2026-08-04): the QA tenant's
-- system_prompt (set in 20260804000018) never mentions images. The
-- assistant has no real vision -- an inbound photo with no caption shows up
-- in its context as just "[Imagen adjunta]" (see whatsapp-webhook), so
-- without guidance it could invent what the photo shows instead of asking.
-- Appends to whatever system_prompt is there now (rather than overwriting
-- it like 20260804000018 did) since a tenant could have edited it manually
-- since then via /app/configuracion.
do $$
declare
  v_updated integer;
begin
  update public.ai_assistants a
  set system_prompt = a.system_prompt || E'\n\nSi el cliente te manda una foto, no podés ver su contenido (todavía no tenés visión) -- se guarda automáticamente adjunta al PQR o seguimiento que estés creando o actualizando en ese momento, así que no hace falta que hagas nada especial con el archivo en sí. Si la foto llega sin ningún texto que explique de qué se trata, preguntale al cliente qué es o para qué caso es -- nunca asumas ni inventes qué muestra la imagen.'
  from public.whatsapp_lines wl
  join public.profiles p on p.tenant_id = wl.tenant_id
  where a.whatsapp_line_id = wl.id
    and p.email = 'qa-uno-admin@example.com';

  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    raise exception 'No ai_assistants row matched a whatsapp_line for the tenant of profile qa-uno-admin@example.com -- check the email is correct and that this tenant has a WhatsApp line with an assistant already configured.';
  end if;

  raise notice 'Updated % ai_assistants row(s)', v_updated;
end $$;
