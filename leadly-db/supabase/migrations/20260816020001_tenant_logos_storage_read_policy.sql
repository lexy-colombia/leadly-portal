-- Fix: subir el logo de la empresa tiraba "new row violates row-level
-- security policy" para tenant_admin/tenant_agent (probado en producción,
-- tenant Lexy Colombia). Causa real: el bucket `tenant-logos` nunca tuvo
-- una policy de SELECT en storage.objects -- solo insert/update/delete
-- (20260804000009_tenant_logo_self_service.sql las creó, pero se olvidó la
-- de lectura). El INSERT en sí pasaba bien (la condición de
-- tenant_logos_write es correcta), pero el cliente de Supabase hace
-- `insert ... returning *`, y Postgres exige que la fila insertada también
-- sea visible por una policy de SELECT para poder devolverla -- sin
-- ninguna, la falla es indistinguible de un rechazo del propio insert
-- (mismo mensaje genérico), lo que hizo perder tiempo diagnosticándolo.
--
-- Reproducido en la base: el mismo insert sin "returning" pasaba limpio;
-- con "returning" fallaba -- confirma que el problema era exactamente este.
--
-- Se hace pública sin condición de tenant (igual que product_images_storage_read)
-- porque el bucket ya es público (storage.buckets.public = true, "así se ve
-- tu marca dentro de Leadly" en cualquier lado de la UI) -- no hay nada que
-- proteger leyendo el nombre/metadata de un logo.

create policy tenant_logos_read on storage.objects
  for select using (bucket_id = 'tenant-logos');
