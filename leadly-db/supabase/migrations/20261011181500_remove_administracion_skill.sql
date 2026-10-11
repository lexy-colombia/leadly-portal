-- Las herramientas de administración por chat dejan de ser una habilidad del catálogo
-- global: el código las ofrece solo cuando quien escribe tiene la etiqueta
-- "administrador" (ADMINISTRATOR_ONLY en _shared/aiTools.ts, isAdministratorContact).
-- Se elimina la fila de ai_skills y su asignación (FK on delete restrict: primero la
-- asignación).
--
-- Requiere que whatsapp-ai-tools y whatsapp-ai-respond ya estén desplegadas con ese
-- cambio (desplegadas el 2026-10-11); si no, las herramientas dejarían de ofrecerse.
delete from public.ai_assistant_skills where skill_key = 'administracion';
delete from public.ai_skills where key = 'administracion';
