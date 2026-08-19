-- Saca PQR del esquema ERP paralelo (pqrs/pqr_updates), a pedido explícito
-- del usuario. Ojo, alcance acotado a propósito:
--
-- - NO se toca crm_pqrs/crm_pqr_updates/crm_attachments ni ai_skills/
--   ai_assistant_skills -- esas son las tablas VIEJAS, en uso real en
--   producción (Aurora responde PQR por WhatsApp hoy mismo con ellas).
--   Borrarlas rompería esa funcionalidad en vivo, y va directo contra la
--   regla del pivote de no tocar ninguna crm_*. Si de verdad se quiere
--   dar de baja esa función de negocio (no solo el modelado paralelo),
--   es una decisión aparte que hay que confirmar explícitamente.
-- - `attachments` (la tabla nueva) NO se borra entera -- también sirve
--   para adjuntar archivos a tasks/sales_order_comments, que no tienen
--   nada que ver con PQR. Se le quitan solo las columnas pqr_id/
--   pqr_update_id y se angosta el check de "exactamente un padre" a los
--   dos que quedan.

alter table public.attachments drop constraint attachments_exactly_one_parent;

alter table public.attachments
  drop column pqr_id,
  drop column pqr_update_id;

alter table public.attachments add constraint attachments_exactly_one_parent check (
  (case when task_id is not null then 1 else 0 end)
  + (case when sales_order_comment_id is not null then 1 else 0 end) = 1
);

drop table public.pqr_updates;
drop table public.pqrs;

drop function public.set_pqr_update_seq();
drop function public.set_pqr_code();
