-- 20261009170000 agregó la etiqueta "administrador" sin ignorar mayúsculas y el cliente
-- ya tenía "ADMINISTRADOR": quedó duplicada. Se conserva la original y se quita la copia.
-- (get_pipeline_report compara la etiqueta sin distinguir mayúsculas, así que cualquiera sirve.)
update public.clients
   set tags = array_remove(tags, 'administrador')
 where tenant_id = '7419c825-4d72-45af-bf40-73375eed9f9c'
   and phone_prefix = '57'
   and phone = '3138314923'
   and deleted_at is null
   and 'ADMINISTRADOR' = any (tags)
   and 'administrador' = any (tags);
