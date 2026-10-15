-- Faiver Moyano (tenant 7419c825-4d72-45af-bf40-73375eed9f9c): etiqueta de proyecto
-- ("el nogal" / "portal de la sierra") en clients.tags según el campo personalizado
-- "Proyecto o propiedad". Las etiquetas de cliente son texto libre (no hay catálogo).
-- Idempotente: no duplica ni toca las demás etiquetas.
do $tags$
declare
  t constant uuid := '7419c825-4d72-45af-bf40-73375eed9f9c';
  f_proy uuid;
begin
  select id into f_proy from public.custom_field_definitions
  where tenant_id = t and entity_type = 'client' and name = 'Proyecto o propiedad'
    and is_active and deleted_at is null;
  if f_proy is null then
    raise exception 'Falta el campo "Proyecto o propiedad".';
  end if;

  update public.clients c
     set tags = array_append(coalesce(c.tags, '{}'), v.tag)
    from (values ('El Nogal', 'el nogal'), ('Portal de la Sierra', 'portal de la sierra')) as v(proyecto, tag)
   where c.tenant_id = t
     and c.deleted_at is null
     and c.custom_fields ->> f_proy::text = v.proyecto
     and not exists (select 1 from unnest(coalesce(c.tags, '{}')) x where lower(btrim(x)) = v.tag);
end
$tags$;
