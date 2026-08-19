-- Elimina la función de PQR (Petición/Queja/Reclamo) por completo -- pedido
-- explícito del usuario (2026-08-17): "eliminar todo lo relacionado a esto
-- incluyendo las tools de la ia". Hasta ahora era una regla dura del
-- proyecto no tocar esto (Aurora la usaba en vivo) -- esta migración es esa
-- decisión explícita de dar de baja la función de negocio, no solo el
-- modelado paralelo (que ya se había limpiado el 2026-08-16, ver
-- 20260816010001_core_drop_pqr.sql, sin tocar nada de esto).
--
-- El frontend (ContactoDetalle.tsx, PqrDrawer.tsx, lib/api/pqrs.ts,
-- lib/api/pqrUpdates.ts) y los Edge Functions (whatsapp-ai-tools,
-- whatsapp-ai-respond, _shared/aiTools.ts) se limpian en el mismo momento
-- que esta migración.

-- ai_assistant_skills.skill_key -> ai_skills(key) es "on delete restrict",
-- así que hay que vaciar las asignaciones antes de poder borrar la fila del
-- catálogo (2 asistentes tenían "pqr" habilitado hoy).
delete from public.ai_assistant_skills where skill_key = 'pqr';
delete from public.ai_skills where key = 'pqr';

-- crm_attachments es compartida con Tareas (task_id) -- no se borra, solo
-- pierde las columnas de PQR. Con task_id como único padre posible, el
-- check de "exactamente un padre" se simplifica a "task_id no nulo".
alter table public.crm_attachments drop constraint crm_attachments_exactly_one_parent;
alter table public.crm_attachments drop column pqr_id;
alter table public.crm_attachments drop column pqr_update_id;
alter table public.crm_attachments add constraint crm_attachments_task_id_required check (task_id is not null);

drop trigger trg_crm_pqr_updates_set_seq on public.crm_pqr_updates;
drop function public.set_crm_pqr_update_seq();

drop trigger trg_crm_pqrs_set_code on public.crm_pqrs;
drop function public.set_crm_pqr_code();

drop table public.crm_pqr_updates;
drop table public.crm_pqrs;
