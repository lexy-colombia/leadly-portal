-- Faiver Moyano: las etiquetas de proyecto pasan a mayúsculas ("EL NOGAL" / "PORTAL DE LA SIERRA").
-- Reemplaza las de 20261014220000 sin tocar las demás etiquetas. Idempotente.
update public.clients c
   set tags = (
     select array_agg(
              case lower(btrim(x))
                when 'el nogal' then 'EL NOGAL'
                when 'portal de la sierra' then 'PORTAL DE LA SIERRA'
                else x
              end order by ord)
       from unnest(c.tags) with ordinality as u(x, ord)
   )
 where c.tenant_id = '7419c825-4d72-45af-bf40-73375eed9f9c'
   and c.deleted_at is null
   and exists (select 1 from unnest(c.tags) x where lower(btrim(x)) in ('el nogal', 'portal de la sierra'));
